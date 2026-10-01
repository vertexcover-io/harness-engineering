import { basename, join, resolve } from "node:path";

// Where a command runs, and what `~`, `$HOME` and `$HARNESS_HOME` stand for there.
export type PathBase = Readonly<{ cwd: string; home: string; harnessHome: string }>;

const WRAPPERS: ReadonlySet<string> = new Set(["sudo", "command", "nohup", "time", "exec"]);
const REMOVERS: ReadonlySet<string> = new Set(["rm", "unlink", "shred", "truncate", "tee"]);
// Commands whose last operand is the destination; a folder destination gets each source's name.
// mv also takes each source away.
const COPIERS: ReadonlySet<string> = new Set(["cp", "install", "rsync", "ln"]);
const IN_PLACE_EDITORS: ReadonlySet<string> = new Set(["sed", "perl", "ruby"]);
const INTERPRETERS: ReadonlySet<string> = new Set([
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "perl",
  "ruby",
]);
// `-i`, `-i.bak`, `-pi`, `-pie`: a cluster of lowercase flags holding `i`; not `-Ilib` or `-Mstrict`.
const IN_PLACE_FLAG = /^-[a-z]*i[a-z]*(?:\..*)?$/;
const CODE_FLAGS: ReadonlySet<string> = new Set(["-c", "-e", "-E", "--eval", "-p"]);
const SCRIPT_FLAGS: ReadonlySet<string> = new Set(["-e", "-f", "--expression", "--file"]);
// A call whose first quoted argument is a path it writes, moves or deletes.
const WRITE_CALL =
  /\b(open|(?:write|append)File(?:Sync)?|(?:unlink|rename|rm|truncate)(?:Sync)?|remove|Bun\.write)\s*\(/g;
const PATH_METHOD =
  /\bPath\(\s*(["'])((?:(?!\1).)+)\1\s*\)\s*\.(?:write_text|write_bytes|unlink|rename|replace|touch)\b/g;
const FIRST_QUOTED = /^\s*(["'])((?:(?!\1).)+)\1/;
const WRITE_MODE = /^\s*,\s*(?:mode\s*=\s*)?["'][^"']*[wax+]/;
const HEREDOC = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w]*))/;
const REDIRECT_OPERATOR = /^(?:\d+>>?|&>>?|>>?\|?)$/;
const REDIRECT_ATTACHED = /^(?:\d*|&)>>?\|?(.+)$/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const HARNESS_HOME_PREFIX = /^(?:\$HARNESS_HOME|\$\{HARNESS_HOME\})(?=\/|$)/;
const SEPARATORS: ReadonlySet<string> = new Set([";", "&", "|", "\n", "(", ")"]);

// The absolute path a word names, or undefined when it holds a variable this cannot know.
export const expandPath = (word: string, base: PathBase): string | undefined => {
  const expanded = word
    .replace(HOME_PREFIX, base.home)
    .replace(HARNESS_HOME_PREFIX, base.harnessHome);
  return expanded.includes("$") ? undefined : resolve(base.cwd, expanded);
};

type Heredoc = Readonly<{ word: string; strip: boolean }>;
type Body = Readonly<{ opener: string; lines: readonly string[] }>;

const heredocOf = (line: string): Heredoc | undefined => {
  const match = HEREDOC.exec(line);
  if (match === null || line.includes("<<<")) return undefined;
  const word = match[1] ?? match[2] ?? match[3];
  return word === undefined ? undefined : { word, strip: match[0].startsWith("<<-") };
};

// A heredoc body is data for the command that opened it, never a command itself.
const splitHeredocs = (command: string): Readonly<{ text: string; bodies: readonly Body[] }> => {
  const kept: string[] = [];
  const bodies: Body[] = [];
  let open: (Heredoc & { opener: string; lines: string[] }) | undefined;
  for (const line of command.split("\n")) {
    if (open === undefined) {
      kept.push(line);
      const heredoc = heredocOf(line);
      open = heredoc === undefined ? undefined : { ...heredoc, opener: line, lines: [] };
      continue;
    }
    if ((open.strip ? line.replace(/^\t+/, "") : line) !== open.word) {
      open.lines.push(line);
      continue;
    }
    bodies.push({ opener: open.opener, lines: open.lines });
    open = undefined;
  }
  return { text: kept.join("\n"), bodies };
};

const startsWord = (text: string, i: number): boolean =>
  i === 0 || /\s/.test(text.charAt(i - 1)) || SEPARATORS.has(text.charAt(i - 1));

// Splits on separators outside quotes and drops `#` comments; an unclosed quote runs to the end.
const splitSegments = (text: string): readonly string[] => {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quote !== undefined) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += text.charAt(i + 1);
        i += 1;
      } else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "#" && startsWord(text, i)) {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline - 1;
    } else if (char === "\\") {
      current += char + text.charAt(i + 1);
      i += 1;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === "&" && (text.charAt(i - 1) === ">" || text.charAt(i + 1) === ">")) {
      current += char;
    } else if (SEPARATORS.has(char)) {
      segments.push(current);
      current = "";
    } else current += char;
  }
  segments.push(current);
  return segments;
};

const shellWords = (segment: string): readonly string[] | undefined => {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: string | undefined;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment.charAt(i);
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
    } else if (quote === '"') {
      if (char === "\\" && (segment.charAt(i + 1) === '"' || segment.charAt(i + 1) === "\\")) {
        current += segment.charAt(i + 1);
        i += 1;
      } else if (char === '"') quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\") {
      current += segment.charAt(i + 1);
      inWord = true;
      i += 1;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (inWord) words.push(current);
  return words;
};

type Split = Readonly<{ argv: readonly string[]; redirects: readonly string[] }>;

const splitRedirects = (words: readonly string[]): Split => {
  const argv: string[] = [];
  const redirects: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    const attached = REDIRECT_ATTACHED.exec(word);
    if (REDIRECT_OPERATOR.test(word)) {
      const target = words[i + 1];
      if (target !== undefined) redirects.push(target);
      i += 1;
    } else if (attached?.[1] !== undefined && !attached[1].startsWith("&")) {
      redirects.push(attached[1]);
    } else if (!/^\d*>&/.test(word) && !word.startsWith("<")) {
      argv.push(word);
    }
  }
  return { argv, redirects };
};

const dropWrappers = (argv: readonly string[]): readonly string[] => {
  let rest = argv;
  for (;;) {
    const [first = "", ...tail] = rest;
    if (ASSIGNMENT.test(first) || WRAPPERS.has(basename(first))) rest = tail;
    else if (basename(first) === "env")
      rest = tail.filter((word) => !word.startsWith("-") && !ASSIGNMENT.test(word));
    else return rest;
  }
};

const callPath = (name: string, rest: string): readonly string[] => {
  const path = FIRST_QUOTED.exec(rest);
  if (path?.[2] === undefined) return [];
  if (name === "open" && !WRITE_MODE.test(rest.slice(path[0].length))) return [];
  return [path[2]];
};

// The paths interpreter code writes: the first quoted argument of each write call.
const codeWrites = (code: string): readonly string[] => [
  ...[...code.matchAll(WRITE_CALL)].flatMap((call) =>
    callPath(call[1] ?? "", code.slice((call.index ?? 0) + call[0].length)),
  ),
  ...[...code.matchAll(PATH_METHOD)].flatMap((call) => (call[2] === undefined ? [] : [call[2]])),
];

const operandsOf = (args: readonly string[]): readonly string[] =>
  args.filter((arg) => arg !== "" && !arg.startsWith("-"));

const copyTargets = (operands: readonly string[]): readonly string[] => {
  const destination = operands.at(-1);
  if (destination === undefined) return [];
  const intoFolder = operands.slice(0, -1).map((source) => join(destination, basename(source)));
  return [destination, ...intoFolder];
};

// sed takes its script as the first operand unless -e or -f names it; perl and ruby take it after -e.
const inPlaceTargets = (name: string, args: readonly string[]): readonly string[] => {
  if (!args.some((arg) => IN_PLACE_FLAG.test(arg) || arg.startsWith("--in-place"))) return [];
  const withoutCode = args.filter((_, i) => !CODE_FLAGS.has(args[i - 1] ?? ""));
  const operands = operandsOf(withoutCode);
  const scriptFirst = name === "sed" && !args.some((arg) => SCRIPT_FLAGS.has(arg));
  return scriptFirst ? operands.slice(1) : operands;
};

const inlineCodeTargets = (args: readonly string[]): readonly string[] => {
  const flag = args.findIndex((arg) => CODE_FLAGS.has(arg));
  const code = flag === -1 ? undefined : args[flag + 1];
  return code === undefined ? [] : codeWrites(code);
};

const commandTargets = (name: string, args: readonly string[]): readonly string[] => {
  const operands = operandsOf(args);
  if (REMOVERS.has(name)) return operands;
  if (name === "mv") return [...operands.slice(0, -1), ...copyTargets(operands)];
  if (COPIERS.has(name)) return copyTargets(operands);
  if (name === "dd") return args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3));
  const inPlace = IN_PLACE_EDITORS.has(name) ? inPlaceTargets(name, args) : [];
  const inline = INTERPRETERS.has(name) ? inlineCodeTargets(args) : [];
  return [...inPlace, ...inline];
};

const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash"]);
const SHELL_COMMAND_FLAG = /^-[a-z]*c[a-z]*$/;
const MAX_NESTING = 3;

// The script a shell -c or eval runs, which is a command in its own right.
const nestedScript = (name: string, args: readonly string[]): string | undefined => {
  if (name === "eval") return args.join(" ");
  if (!SHELLS.has(name)) return undefined;
  const flag = args.findIndex((arg) => SHELL_COMMAND_FLAG.test(arg));
  return flag === -1 ? undefined : args[flag + 1];
};

type Segment = Readonly<{ name: string; args: readonly string[]; redirects: readonly string[] }>;

// A segment's command name, its arguments and its redirection targets; undefined when it can't be read.
const parseSegment = (segment: string): Segment | undefined => {
  const words = shellWords(segment);
  if (words === undefined) return undefined;
  const { argv: raw, redirects } = splitRedirects(words);
  const [command = "", ...args] = dropWrappers(raw);
  return { name: basename(command), args, redirects };
};

// A heredoc feeding an interpreter is its program, so its write calls count.
const heredocTargets = (bodies: readonly Body[]): readonly string[] =>
  bodies.flatMap((body) => {
    const opener = splitSegments(body.opener).find((segment) => segment.includes("<<")) ?? "";
    const name = parseSegment(opener)?.name ?? "";
    return INTERPRETERS.has(name) ? codeWrites(body.lines.join("\n")) : [];
  });

const expandAll = (paths: readonly string[], base: PathBase): readonly string[] =>
  paths.flatMap((path) => {
    const expanded = expandPath(path, base);
    return expanded === undefined ? [] : [expanded];
  });

// The absolute paths a shell command writes, moves or deletes. A segment it cannot parse gives none.
export const shellWriteTargets = (
  command: string,
  base: PathBase,
  depth = 0,
): readonly string[] => {
  const { text: commands, bodies } = splitHeredocs(command);
  let cwd = base.cwd;
  const targets: string[] = [...expandAll(heredocTargets(bodies), base)];
  for (const text of splitSegments(commands)) {
    const segment = parseSegment(text);
    if (segment === undefined) continue;
    const { name, args, redirects } = segment;
    const here = { ...base, cwd };
    if (name === "cd" && args[0] !== undefined) {
      cwd = expandPath(args[0], here) ?? cwd;
      continue;
    }
    const script = depth < MAX_NESTING ? nestedScript(name, args) : undefined;
    if (script !== undefined) targets.push(...shellWriteTargets(script, here, depth + 1));
    targets.push(...expandAll([...redirects, ...commandTargets(name, args)], here));
  }
  return targets;
};
