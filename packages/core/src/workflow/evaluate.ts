import type { JsonValue, NodeRun } from "@yok/sdk";
import { NodeFailure } from "./types.ts";

// What an expression can read of a node, from its node run in state.json.
export type NodeResult = Readonly<Pick<NodeRun, "status" | "input" | "output">>;

export type IterationView = Readonly<{
  index: number;
  max: number;
  previous: JsonValue;
  nodes: Readonly<Record<string, NodeResult>>;
}>;

export type Scope = Readonly<{
  inputs: JsonValue;
  nodes: Readonly<Record<string, NodeResult>>;
  iteration?: IterationView;
}>;

const EXPRESSION = /\{\{(.*?)\}\}/gs;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const BLOCKED = new Set(["__proto__", "prototype", "constructor"]);
const NODE_FIELDS = new Set(["input", "output", "status"]);

const fail = (message: string): never => {
  throw new NodeFailure("resolution", message);
};

export const expressionsIn = (text: string): string[] =>
  [...text.matchAll(EXPRESSION)].map((match) => match[1] ?? "");

export const isWholeExpression = (text: string): boolean => {
  const matches = [...text.matchAll(EXPRESSION)];
  return matches.length === 1 && matches[0]?.[0] === text;
};

export const parsePath = (expression: string): string[] => {
  const text = expression.trim();
  const segments = text.split(".");
  const [root, id] = segments;
  if (segments.some((s) => !SEGMENT.test(s) || BLOCKED.has(s)))
    return fail(`invalid path "${text}"`);
  if (root === "inputs") return segments;
  if (root === "iteration" && (id === "index" || id === "max" || id === "previous"))
    return segments;
  const nodeSegments = root === "iteration" && id === "nodes" ? segments.slice(1) : segments;
  const [nodesRoot, nodeId, nodeField] = nodeSegments;
  const isNodePath =
    nodesRoot === "nodes" &&
    nodeId !== undefined &&
    nodeField !== undefined &&
    NODE_FIELDS.has(nodeField);
  if (!isNodePath)
    return fail(`"${text}" must start with inputs, iteration or nodes.<id>.input|output|status`);
  if (nodeField === "status" && nodeSegments.length > 3)
    return fail(`"${text}": status has no fields`);
  return segments;
};

const present = (value: JsonValue | undefined, message: string): JsonValue =>
  value === undefined ? fail(message) : value;

const descend = (value: JsonValue, keys: readonly string[], label: string): JsonValue =>
  keys.reduce<JsonValue>((current, key) => {
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      return present(current[Number(key)], `${label}: no item ${key}`);
    }
    if (
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      Object.hasOwn(current, key)
    ) {
      return present(current[key], `${label}: missing field "${key}"`);
    }
    return fail(`${label}: missing field "${key}"`);
  }, value);

const readNode = (
  views: Readonly<Record<string, NodeResult>>,
  [id = "", field, ...rest]: readonly string[],
  label: string,
): JsonValue => {
  const view = Object.hasOwn(views, id) ? views[id] : undefined;
  if (view === undefined) return fail(`${label}: node "${id}" is not visible here`);
  if (field === "status") return view.status;
  if (field === "input")
    return descend(present(view.input, `${label}: "${id}" has no input`), rest, label);
  if (view.status !== "completed")
    return fail(`${label}: "${id}" ${view.status} and has no output`);
  return descend(present(view.output, `${label}: "${id}" has no output`), rest, label);
};

const readPath = (scope: Scope, segments: readonly string[]): JsonValue => {
  const label = segments.join(".");
  const [root, ...rest] = segments;
  if (root === "inputs") return descend(scope.inputs, rest, label);
  if (root === "nodes") return readNode(scope.nodes, rest, label);
  const iteration = scope.iteration ?? fail(`${label}: iteration is only available inside a loop`);
  const [part, ...more] = rest;
  if (part === "index") return descend(iteration.index, more, label);
  if (part === "max") return descend(iteration.max, more, label);
  if (part === "previous") return descend(iteration.previous, more, label);
  return readNode(iteration.nodes, more, label);
};

type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

type Ast =
  | { kind: "literal"; value: JsonValue }
  | { kind: "path"; segments: string[] }
  | { kind: "not"; operand: Ast }
  | { kind: "and" | "or"; left: Ast; right: Ast }
  | { kind: "compare"; op: CompareOp; left: Ast; right: Ast };

type Token = { type: "op" | "string" | "number" | "word"; text: string };

const TOKEN =
  /\s*(?:(==|!=|<=|>=|<|>|\(|\))|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.-]*))/y;
const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);
const KEYWORDS = new Set(["and", "or", "not", "true", "false", "null"]);

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (source.slice(TOKEN.lastIndex).trim() !== "") {
    const match = TOKEN.exec(source);
    if (match === null) return fail(`cannot parse "${source.trim()}"`);
    const [, op, str, num, word] = match;
    if (op !== undefined) tokens.push({ type: "op", text: op });
    else if (str !== undefined) tokens.push({ type: "string", text: str });
    else if (num !== undefined) tokens.push({ type: "number", text: num });
    else if (word !== undefined) tokens.push({ type: "word", text: word });
  }
  return tokens;
};

const unquote = (text: string): string => text.slice(1, -1).replace(/\\(.)/g, "$1");

export const parseExpression = (source: string): Ast => {
  const tokens = tokenize(source);
  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const take = (): Token | undefined => tokens[position++];
  const isWord = (token: Token | undefined, word: string): boolean =>
    token?.type === "word" && token.text === word;
  const parseAtom = (): Ast => {
    const token = take();
    if (token === undefined) return fail(`"${source.trim()}" ends early`);
    if (token.type === "op" && token.text === "(") {
      const inner = parseOr();
      if (take()?.text !== ")") return fail(`"${source.trim()}" is missing ")"`);
      return inner;
    }
    if (token.type === "string") return { kind: "literal", value: unquote(token.text) };
    if (token.type === "number") return { kind: "literal", value: Number(token.text) };
    if (isWord(token, "true")) return { kind: "literal", value: true };
    if (isWord(token, "false")) return { kind: "literal", value: false };
    if (isWord(token, "null")) return { kind: "literal", value: null };
    if (token.type === "word" && !KEYWORDS.has(token.text))
      return { kind: "path", segments: parsePath(token.text) };
    return fail(`unexpected "${token.text}" in "${source.trim()}"`);
  };
  const parseCompare = (): Ast => {
    const left = parseAtom();
    const token = peek();
    if (token?.type !== "op" || !COMPARE.has(token.text)) return left;
    take();
    return { kind: "compare", op: token.text as CompareOp, left, right: parseAtom() };
  };
  const parseNot = (): Ast => {
    if (!isWord(peek(), "not")) return parseCompare();
    take();
    return { kind: "not", operand: parseNot() };
  };
  const parseAnd = (): Ast => {
    let left = parseNot();
    while (isWord(peek(), "and")) {
      take();
      left = { kind: "and", left, right: parseNot() };
    }
    return left;
  };
  function parseOr(): Ast {
    let left = parseAnd();
    while (isWord(peek(), "or")) {
      take();
      left = { kind: "or", left, right: parseAnd() };
    }
    return left;
  }
  const ast = parseOr();
  if (position < tokens.length)
    return fail(`unexpected "${tokens[position]?.text}" in "${source.trim()}"`);
  return ast;
};

const isScalar = (value: JsonValue): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const asBoolean = (value: JsonValue, op: string): boolean =>
  typeof value === "boolean" ? value : fail(`${op} needs booleans, got ${JSON.stringify(value)}`);

const compare = (op: CompareOp, left: JsonValue, right: JsonValue): boolean => {
  if (!isScalar(left) || !isScalar(right)) return fail(`${op} compares scalars only`);
  if (op === "==") return left === right;
  if (op === "!=") return left !== right;
  const sign =
    typeof left === "number" && typeof right === "number"
      ? Math.sign(left - right)
      : typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right)
        : fail(`${op} needs two numbers or two strings`);
  return { "<": sign < 0, "<=": sign <= 0, ">": sign > 0, ">=": sign >= 0 }[op];
};

const evaluateAst = (ast: Ast, scope: Scope): JsonValue => {
  switch (ast.kind) {
    case "literal":
      return ast.value;
    case "path":
      return readPath(scope, ast.segments);
    case "not":
      return !asBoolean(evaluateAst(ast.operand, scope), "not");
    case "and":
      return (
        asBoolean(evaluateAst(ast.left, scope), "and") &&
        asBoolean(evaluateAst(ast.right, scope), "and")
      );
    case "or":
      return (
        asBoolean(evaluateAst(ast.left, scope), "or") ||
        asBoolean(evaluateAst(ast.right, scope), "or")
      );
    case "compare":
      return compare(ast.op, evaluateAst(ast.left, scope), evaluateAst(ast.right, scope));
  }
};

const evaluate = (expression: string, scope: Scope): JsonValue =>
  evaluateAst(parseExpression(expression), scope);

const single = (text: string): string =>
  isWholeExpression(text)
    ? (expressionsIn(text)[0] ?? "")
    : fail(`"${text}" must be exactly one {{ expression }}`);

export const evaluateBoolean = (text: string, scope: Scope): boolean =>
  asBoolean(evaluate(single(text), scope), text);

export const evaluateScalar = (text: string, scope: Scope): string | number | boolean | null => {
  const value = evaluate(single(text), scope);
  return isScalar(value) ? value : fail(`${text} must produce a string, number, boolean or null`);
};

const pathsIn = (ast: Ast): string[][] => {
  switch (ast.kind) {
    case "literal":
      return [];
    case "path":
      return [ast.segments];
    case "not":
      return pathsIn(ast.operand);
    default:
      return [...pathsIn(ast.left), ...pathsIn(ast.right)];
  }
};

const resolveString = (text: string, scope: Scope): JsonValue => {
  if (isWholeExpression(text)) return evaluate(expressionsIn(text)[0] ?? "", scope);
  return text.replace(EXPRESSION, (_match, expression: string) => {
    const value = evaluate(expression, scope);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
};

export const resolveValue = (value: JsonValue, scope: Scope): JsonValue => {
  if (typeof value === "string") return resolveString(value, scope);
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, scope));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveValue(item, scope)]),
    );
  }
  return value;
};

export const expressionPaths = (value: JsonValue): string[][] => {
  if (typeof value === "string")
    return expressionsIn(value).flatMap((e) => pathsIn(parseExpression(e)));
  if (Array.isArray(value)) return value.flatMap(expressionPaths);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(expressionPaths);
  return [];
};
