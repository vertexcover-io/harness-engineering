#!/usr/bin/env node --experimental-strip-types

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatMessage, loadConfig, resolveProvider } from "./notify.ts";
import type { Args, HookFailure, PendingQuestion, Provider } from "./notify.ts";

export const EVENTS = [
  "run-started",
  "stage-started",
  "stage-completed",
  "question-pending",
  "run-interrupted",
  "run-completed",
  "artifact-created",
  "hook-failed",
] as const;
export type EventName = (typeof EVENTS)[number];

export const KINDS = ["pr", "commit", "plan", "proof-report"] as const;
export type ArtifactKind = (typeof KINDS)[number];

export type HookWhen = {
  readonly stage?: string;
  readonly result?: string;
  readonly kind?: string;
};

// What the config file holds: unknown until parsed.
export type RawEntry = unknown;

export type EntryBase = {
  readonly name: string;
  readonly when?: HookWhen;
  readonly required?: boolean;
  readonly report?: boolean;
  readonly timeoutMs?: number;
};
export type CmdEntry = EntryBase & { readonly cmd: string };
export type FnEntry = EntryBase & { readonly fn: { readonly module: string; readonly export?: string } };
export type PromptEntry = EntryBase & { readonly prompt: string };
// One of three, never a bag of optionals — "exactly one of fn/cmd/prompt" is the type itself,
// so past parseEntry there is no such thing as an entry with no command to run.
export type ValidEntry = CmdEntry | FnEntry | PromptEntry;

export type PayloadBase = {
  readonly stage?: string;
  readonly result?: string;
  readonly spec?: string;
  readonly branch: string;
  readonly repoRoot: string;
  readonly artifactDir?: string;
};

export type EventText = { readonly title?: string; readonly body?: string };

export type StageArtifact = { readonly name: string; readonly path: string };
export type StageCompletedData = EventText & {
  readonly artifacts?: readonly StageArtifact[];
};

export type RunStartedPayload = PayloadBase & { readonly event: "run-started"; readonly data: EventText };
export type StageStartedPayload = PayloadBase & { readonly event: "stage-started"; readonly data: EventText };
export type StageCompletedPayload = PayloadBase & {
  readonly event: "stage-completed";
  readonly data: StageCompletedData;
};
export type QuestionPendingData = {
  readonly title?: string;
  readonly questions?: readonly PendingQuestion[];
};
export type QuestionPendingPayload = PayloadBase & {
  readonly event: "question-pending";
  readonly data: QuestionPendingData;
};
export type RunInterruptedPayload = PayloadBase & {
  readonly event: "run-interrupted";
  readonly data: EventText;
};
export type RunCompletedPayload = PayloadBase & { readonly event: "run-completed"; readonly data: EventText };
export type HookFailedPayload = PayloadBase & {
  readonly event: "hook-failed";
  readonly data: HookFailure & { readonly title?: string };
};

export type PrCreatedPayload = PayloadBase & {
  readonly event: "artifact-created";
  readonly kind: "pr";
  readonly data: { readonly url: string };
};
export type CommitCreatedPayload = PayloadBase & {
  readonly event: "artifact-created";
  readonly kind: "commit";
  readonly data: { readonly sha: string };
};
export type PlanCreatedPayload = PayloadBase & {
  readonly event: "artifact-created";
  readonly kind: "plan";
  readonly data: { readonly path: string };
};
export type ProofReportCreatedPayload = PayloadBase & {
  readonly event: "artifact-created";
  readonly kind: "proof-report";
  readonly data: { readonly path: string };
};

export type LifecyclePayload =
  | RunStartedPayload
  | StageStartedPayload
  | StageCompletedPayload
  | QuestionPendingPayload
  | RunInterruptedPayload
  | RunCompletedPayload
  | HookFailedPayload;

export type Payload =
  | LifecyclePayload
  | PrCreatedPayload
  | CommitCreatedPayload
  | PlanCreatedPayload
  | ProofReportCreatedPayload;

export type LifecycleEvent = Exclude<EventName, "artifact-created">;
export type RawData = Readonly<Record<string, unknown>>;

type FireFlagsBase = {
  readonly stage?: string;
  readonly result?: "pass" | "fail";
  readonly spec?: string;
  readonly data?: RawData;
};
// A union, so `kind` cannot go missing on the one event that needs it, or be set on any other.
export type FireFlags =
  | (FireFlagsBase & { readonly event: LifecycleEvent })
  | (FireFlagsBase & { readonly event: "artifact-created"; readonly kind: ArtifactKind });

export type HookStatus = "success" | "failure" | "skipped";
// The one field a caller must read. `invalid` is the only value that comes with a non-zero exit:
// the command never fired, so re-firing it is safe. `halt` is a pause, not a stage failure.
export type FireStatus = "success" | "failure" | "skipped" | "halt" | "invalid";
export type HookResult = {
  readonly status: HookStatus;
  readonly result?: string;
};

export type PromptTodo = {
  readonly name: string;
  readonly prompt: string;
  readonly payload: Payload;
  readonly required: boolean;
};

export type FireOutput = {
  readonly status: FireStatus;
  /** Why, in one line. Set on `invalid` and on `halt`; the per-hook detail lives in `results`. */
  readonly result?: string;
  readonly results?: Readonly<Record<string, HookResult>>;
  readonly prompts?: readonly PromptTodo[];
};
export type Fired = { readonly out: FireOutput; readonly halt?: string };

export type Exec = (
  cmd: string,
  opts: { readonly input: string; readonly timeoutMs: number },
) => { readonly exit: number; readonly stdout: string; readonly stderr: string };

export type FireDeps = {
  readonly exec: Exec;
  readonly importModule: (path: string) => Promise<Record<string, unknown>>;
  readonly cwd: string;
};

export type HooksConfig = {
  readonly hooks: Readonly<Record<string, readonly RawEntry[]>>;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly repoRoot: string;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const CONFIG_FILE = "orchestrate.config.json";
const SELF = fileURLToPath(import.meta.url);
const NOTIFIER_EVENTS: ReadonlySet<string> = new Set([
  "run-started",
  "stage-started",
  "stage-completed",
  "question-pending",
  "run-interrupted",
  "run-completed",
  "hook-failed",
]);

const findRepoRoot = (cwd: string): string => {
  try {
    const lines = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim().split("\n");
    return lines[0] ?? cwd;
  } catch {
    return cwd;
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const toHooksBlock = (raw: Record<string, unknown>): Record<string, readonly RawEntry[]> => {
  if (!isRecord(raw.hooks)) return {};
  const hooks: Record<string, readonly RawEntry[]> = {};
  for (const [event, list] of Object.entries(raw.hooks)) {
    if (Array.isArray(list)) hooks[event] = list;
  }
  return hooks;
};

export const loadHooks = (cwd: string): HooksConfig => {
  const repoRoot = findRepoRoot(cwd);
  const configFile = join(repoRoot, CONFIG_FILE);
  if (!existsSync(configFile)) return { hooks: {}, raw: {}, repoRoot };
  try {
    const raw = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    return { hooks: toHooksBlock(raw), raw, repoRoot };
  } catch {
    return { hooks: {}, raw: {}, repoRoot };
  }
};

export const buildPayload = (flags: FireFlags, repoRoot: string, cwd: string): Payload => {
  let branch = "";
  try {
    branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    branch = "";
  }

  const base: PayloadBase = {
    ...(flags.stage !== undefined ? { stage: flags.stage } : {}),
    ...(flags.result !== undefined ? { result: flags.result } : {}),
    ...(flags.spec !== undefined ? { spec: flags.spec } : {}),
    branch,
    repoRoot,
    ...(flags.spec !== undefined ? { artifactDir: join(repoRoot, ".harness", flags.spec) } : {}),
  };

  const parsed = parseData(flags, base);
  // Unreachable through the CLI — parseFireArgv runs the same parse and rejects the command
  // before anything fires. runFire is a library too: a direct caller with bad data gets a
  // named error, not a payload whose types lie.
  if (!parsed.ok) {
    throw new Error(`--data does not fit --event ${flags.event}: ${parsed.problems.join("; ")}`);
  }
  return parsed.value;
};

export const matchWhen = (when: HookWhen | undefined, p: Payload): boolean =>
  when === undefined ||
  // HookWhen's keys (stage, result, kind) are always Payload fields — present, optional, or
  // simply absent on a given member — so a missing key just reads as undefined and fails
  // the comparison naturally; this is a plain string-keyed read, not a validation bypass.
  Object.entries(when).every(([k, v]) => (p as Readonly<Record<string, unknown>>)[k] === v);

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly string[] };

const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

const parseFn = (v: unknown, problems: string[]): { module: string; export?: string } | undefined => {
  if (v === undefined) return undefined;
  if (!isRecord(v)) {
    problems.push("fn must be an object");
    return undefined;
  }
  if (!isStr(v.module)) problems.push("fn.module must be a string");
  const exported = isStr(v.export) ? v.export : undefined;
  if (v.export !== undefined && exported === undefined) problems.push("fn.export must be a string");
  return isStr(v.module) ? { module: v.module, ...(exported !== undefined ? { export: exported } : {}) } : undefined;
};

const parseWhen = (v: unknown, problems: string[]): HookWhen | undefined => {
  if (v === undefined) return undefined;
  if (!isRecord(v)) {
    problems.push("when must be an object");
    return undefined;
  }
  for (const key of Object.keys(v)) {
    if (!WHEN_KEYS.has(key)) problems.push(`when.${key} is not a valid filter key`);
  }
  const field = (key: "stage" | "result" | "kind"): string | undefined => {
    const value = v[key];
    if (value === undefined) return undefined;
    if (!isStr(value)) {
      problems.push(`when.${key} must be a string`);
      return undefined;
    }
    if (key === "kind" && !isArtifactKind(value)) {
      problems.push(`when.kind "${value}" is outside ${KINDS.join(", ")}`);
      return undefined;
    }
    return value;
  };
  const stage = field("stage");
  const result = field("result");
  const kind = field("kind");
  return {
    ...(stage !== undefined ? { stage } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
};

// The one place the entry-shape rules live. runFire skips an entry it rejects; runDoctor turns
// the same problems into FAIL rows. Written twice, they drift, and then doctor green-lights an
// entry fire silently skips.
export const parseEntry = (raw: RawEntry, seen: ReadonlySet<string>): Parsed<ValidEntry> => {
  if (!isRecord(raw)) return { ok: false, problems: ["entry must be an object"] };
  const problems: string[] = [];

  const name = isStr(raw.name) && raw.name !== "" ? raw.name : undefined;
  if (name === undefined) problems.push("missing name");
  else if (seen.has(name)) problems.push(`duplicate name "${name}"`);

  const present = (["fn", "cmd", "prompt"] as const).filter((key) => raw[key] !== undefined);
  if (present.length !== 1) problems.push(`needs exactly one of fn/cmd/prompt (found ${present.length})`);

  const cmd = isStr(raw.cmd) ? raw.cmd : undefined;
  if (raw.cmd !== undefined && cmd === undefined) problems.push("cmd must be a string");

  const prompt = isStr(raw.prompt) ? raw.prompt : undefined;
  if (raw.prompt !== undefined && prompt === undefined) problems.push("prompt must be a string");

  const fn = parseFn(raw.fn, problems);
  const when = parseWhen(raw.when, problems);

  for (const key of ["required", "report"] as const) {
    if (raw[key] !== undefined && !isBool(raw[key])) problems.push(`${key} must be true or false`);
  }
  const timeoutMs = typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : undefined;
  if (raw.timeoutMs !== undefined && timeoutMs === undefined) {
    problems.push("timeoutMs must be a positive number");
  }

  if (name === undefined || problems.length > 0) return { ok: false, problems };

  const base: EntryBase = {
    name,
    ...(when !== undefined ? { when } : {}),
    ...(isBool(raw.required) ? { required: raw.required } : {}),
    ...(isBool(raw.report) ? { report: raw.report } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  if (cmd !== undefined) return { ok: true, value: { ...base, cmd } };
  if (prompt !== undefined) return { ok: true, value: { ...base, prompt } };
  if (fn !== undefined) return { ok: true, value: { ...base, fn } };
  return { ok: false, problems: ["needs exactly one of fn/cmd/prompt (found 0)"] };
};

// --data is untrusted JSON, so each event gets an entry that checks it against the shape that
// event actually carries and builds the payload member itself — the member's types are true at
// runtime the moment it exists. The table is indexed by a union key and needs no cast: each
// entry returns its own concrete payload type, so the indexed call collapses to Parsed<Payload>.
// Every entry also projects — keys the event doesn't carry are dropped, not passed through.
type LifecyclePayloadFor<E extends LifecycleEvent> = Extract<LifecyclePayload, { event: E }>;
type ArtifactPayloadFor<K extends ArtifactKind> = Extract<Payload, { event: "artifact-created"; kind: K }>;

const optStr = (d: RawData, key: string, problems: string[]): string | undefined => {
  const v = d[key];
  if (v === undefined) return undefined;
  if (!isStr(v)) {
    problems.push(`${key} must be a string`);
    return undefined;
  }
  return v;
};
const reqStr = (d: RawData, key: string, problems: string[]): string | undefined => {
  if (d[key] === undefined) {
    problems.push(`missing ${key}`);
    return undefined;
  }
  return optStr(d, key, problems);
};

const textData = (d: RawData, problems: string[]): EventText => {
  const title = optStr(d, "title", problems);
  const body = optStr(d, "body", problems);
  return { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) };
};

const artifactsOf = (d: RawData, problems: string[]): readonly StageArtifact[] | undefined => {
  const v = d.artifacts;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    problems.push("artifacts must be an array");
    return undefined;
  }
  const out: StageArtifact[] = [];
  for (const item of v) {
    if (!isRecord(item) || !isStr(item.name) || !isStr(item.path)) {
      problems.push("each artifact needs name and path strings");
      continue;
    }
    out.push({ name: item.name, path: item.path });
  }
  return out;
};

const answersOf = (v: unknown, problems: string[]): readonly string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    problems.push("answers must be an array of strings");
    return undefined;
  }
  const out = v.filter(isStr);
  if (out.length !== v.length) {
    problems.push("answers must be an array of strings");
    return undefined;
  }
  return out;
};

const questionsOf = (d: RawData, problems: string[]): readonly PendingQuestion[] | undefined => {
  const v = d.questions;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    problems.push("questions must be an array");
    return undefined;
  }
  const out: PendingQuestion[] = [];
  for (const q of v) {
    if (!isRecord(q) || !isStr(q.question)) {
      problems.push("each question needs a question string");
      continue;
    }
    const answers = answersOf(q.answers, problems);
    out.push({ question: q.question, ...(answers !== undefined ? { answers } : {}) });
  }
  return out;
};

const DATA = {
  "run-started": (b: PayloadBase, d: RawData): Parsed<RunStartedPayload> => {
    const problems: string[] = [];
    const data = textData(d, problems);
    return problems.length > 0
      ? { ok: false, problems }
      : { ok: true, value: { ...b, event: "run-started", data } };
  },
  "stage-started": (b: PayloadBase, d: RawData): Parsed<StageStartedPayload> => {
    const problems: string[] = [];
    const data = textData(d, problems);
    return problems.length > 0
      ? { ok: false, problems }
      : { ok: true, value: { ...b, event: "stage-started", data } };
  },
  "stage-completed": (b: PayloadBase, d: RawData): Parsed<StageCompletedPayload> => {
    const problems: string[] = [];
    const title = optStr(d, "title", problems);
    const body = optStr(d, "body", problems);
    const artifacts = artifactsOf(d, problems);
    if (problems.length > 0) return { ok: false, problems };
    return {
      ok: true,
      value: {
        ...b,
        event: "stage-completed",
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(artifacts !== undefined ? { artifacts } : {}),
        },
      },
    };
  },
  "question-pending": (b: PayloadBase, d: RawData): Parsed<QuestionPendingPayload> => {
    const problems: string[] = [];
    const title = optStr(d, "title", problems);
    const questions = questionsOf(d, problems);
    if (problems.length > 0) return { ok: false, problems };
    return {
      ok: true,
      value: {
        ...b,
        event: "question-pending",
        data: { ...(title !== undefined ? { title } : {}), ...(questions !== undefined ? { questions } : {}) },
      },
    };
  },
  "run-interrupted": (b: PayloadBase, d: RawData): Parsed<RunInterruptedPayload> => {
    const problems: string[] = [];
    const data = textData(d, problems);
    return problems.length > 0
      ? { ok: false, problems }
      : { ok: true, value: { ...b, event: "run-interrupted", data } };
  },
  "run-completed": (b: PayloadBase, d: RawData): Parsed<RunCompletedPayload> => {
    const problems: string[] = [];
    const data = textData(d, problems);
    return problems.length > 0
      ? { ok: false, problems }
      : { ok: true, value: { ...b, event: "run-completed", data } };
  },
  // The one lifecycle event whose data is meaningless without its fields: a failure
  // notification with no name or detail says nothing.
  "hook-failed": (b: PayloadBase, d: RawData): Parsed<HookFailedPayload> => {
    const problems: string[] = [];
    const name = reqStr(d, "name", problems);
    const eventName = reqStr(d, "event", problems);
    const detail = reqStr(d, "detail", problems);
    const title = optStr(d, "title", problems);
    if (d.required !== undefined && !isBool(d.required)) problems.push("required must be true or false");
    if (name === undefined || eventName === undefined || detail === undefined || problems.length > 0) {
      return { ok: false, problems };
    }
    return {
      ok: true,
      value: {
        ...b,
        event: "hook-failed",
        data: {
          name,
          event: eventName,
          required: d.required === true,
          detail,
          ...(title !== undefined ? { title } : {}),
        },
      },
    };
  },
} satisfies { readonly [E in LifecycleEvent]: (b: PayloadBase, d: RawData) => Parsed<LifecyclePayloadFor<E>> };

// Every artifact kind's data is one required string; only the key differs.
const ARTIFACT = {
  pr: (b: PayloadBase, d: RawData): Parsed<PrCreatedPayload> => {
    const problems: string[] = [];
    const url = reqStr(d, "url", problems);
    return url === undefined || problems.length > 0
      ? { ok: false, problems }
      : { ok: true, value: { ...b, event: "artifact-created", kind: "pr", data: { url } } };
  },
  commit: (b: PayloadBase, d: RawData): Parsed<CommitCreatedPayload> => {
    const problems: string[] = [];
    const sha = reqStr(d, "sha", problems);
    return sha === undefined || problems.length > 0
      ? { ok: false, problems }
      : { ok: true, value: { ...b, event: "artifact-created", kind: "commit", data: { sha } } };
  },
  plan: (b: PayloadBase, d: RawData): Parsed<PlanCreatedPayload> => {
    const problems: string[] = [];
    const path = reqStr(d, "path", problems);
    return path === undefined || problems.length > 0
      ? { ok: false, problems }
      : { ok: true, value: { ...b, event: "artifact-created", kind: "plan", data: { path } } };
  },
  "proof-report": (b: PayloadBase, d: RawData): Parsed<ProofReportCreatedPayload> => {
    const problems: string[] = [];
    const path = reqStr(d, "path", problems);
    return path === undefined || problems.length > 0
      ? { ok: false, problems }
      : { ok: true, value: { ...b, event: "artifact-created", kind: "proof-report", data: { path } } };
  },
} satisfies { readonly [K in ArtifactKind]: (b: PayloadBase, d: RawData) => Parsed<ArtifactPayloadFor<K>> };

// A base for the parse call parseFireArgv makes purely to reject bad --data — its value is
// thrown away, and no field of the base is involved in any check.
const PARSE_ONLY_BASE: PayloadBase = { branch: "", repoRoot: "" };

const parseData = (flags: FireFlags, base: PayloadBase): Parsed<Payload> => {
  const d = flags.data ?? {};
  return flags.event === "artifact-created" ? ARTIFACT[flags.kind](base, d) : DATA[flags.event](base, d);
};

// The harness's own shipped hooks — same fields, same loop, same envelope as a config hook.
// The notifier is the only one today; it resolves through the ordinary fn machinery (SELF +
// export name), so nothing in the dispatch loop knows it's special.
export const defaultHooks = (event: string, raw: Record<string, unknown>): RawEntry[] => {
  const notifier = raw.notifier;
  const enabled = isRecord(notifier) && notifier.enabled === true;
  return enabled && NOTIFIER_EVENTS.has(event)
    ? [{ name: "notifier", fn: { module: SELF, export: "notifierHook" } }]
    : [];
};

// notifierHook is exported, so callers can hand it anything — it reads defensively even
// though fire-time --data parsing already guarantees the shapes.
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strings = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const hookFailure = (data: HookFailure): HookFailure => ({
  name: str(data.name) ?? "unknown",
  event: str(data.event) ?? "unknown",
  required: data.required === true,
  detail: str(data.detail) ?? "",
});

const askedQuestions = (v: unknown): readonly PendingQuestion[] =>
  (Array.isArray(v) ? v : []).flatMap((q) => {
    const question = str(q?.question);
    return question === null ? [] : [{ question, answers: strings(q.answers) }];
  });

// A plain fn-hook handler: (payload) => Promise<string>, the exact contract every user fn hook
// has. `provider` is a second parameter only tests use, to inject a fake in place of Slack.
// --data is parsed at the fire boundary, so payload.data arrives typed and true — but this is
// an exported function callers can hand anything, so it still reads defensively.
export const notifierHook = async (payload: LifecyclePayload, provider?: Provider): Promise<string> => {
  const config = loadConfig();
  if (config === null) return "disabled";

  const threadFile = payload.artifactDir === undefined ? null : join(payload.artifactDir, "hooks", "thread");
  const starting = payload.event === "run-started";
  // No thread file yet reads as unthreaded — today's behavior for a run with no prior thread.
  const thread =
    !starting && threadFile !== null && existsSync(threadFile) ? readFileSync(threadFile, "utf8").trim() : null;
  const artifacts = payload.event === "stage-completed" ? (payload.data.artifacts ?? []).map((a) => a.path) : [];

  const args: Args = {
    event: payload.event,
    stage: payload.stage ?? null,
    title: str(payload.data.title) ?? payload.spec ?? null,
    body:
      payload.event === "question-pending" || payload.event === "hook-failed"
        ? null
        : str(payload.data.body),
    questions: payload.event === "question-pending" ? askedQuestions(payload.data.questions) : [],
    failure: payload.event === "hook-failed" ? hookFailure(payload.data) : null,
    thread,
    artifacts,
  };
  const message = formatMessage(args);
  const p = provider ?? resolveProvider(config);
  const ts = await p.send(message);
  // stage-completed is the event that carries several artifacts; the uploads are independent
  // round-trips, so serializing them would make that stage wait for N of them in turn.
  await Promise.all(artifacts.map((file) => p.upload(file, message)));

  // Threading is self-managed: run-started writes the returned ts, every later event reads it.
  // A re-run overwrites the file, so each run threads fresh.
  if (starting && ts !== null && threadFile !== null) {
    mkdirSync(dirname(threadFile), { recursive: true });
    writeFileSync(threadFile, ts);
  }
  return ts ?? "sent";
};

type HookOutcome = { readonly failed: boolean; readonly detail: string; readonly output: string };

const runCmd = (entry: CmdEntry, payload: Payload, deps: FireDeps): HookOutcome => {
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const r = deps.exec(entry.cmd, { input: JSON.stringify(payload), timeoutMs });
  if (Date.now() - start >= timeoutMs) {
    return { failed: true, detail: `timed out after ${timeoutMs}ms`, output: r.stdout };
  }
  if (r.exit !== 0) {
    return { failed: true, detail: `exit ${r.exit}${r.stderr ? `: ${r.stderr.trim()}` : ""}`, output: r.stdout };
  }
  return { failed: false, detail: "", output: r.stdout };
};

const runFn = async (entry: FnEntry, payload: Payload, deps: FireDeps): Promise<HookOutcome> => {
  const fn = entry.fn;
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const call = (async (): Promise<HookOutcome> => {
    const mod = await deps.importModule(fn.module);
    const exportName = fn.export ?? "default";
    const handler = mod[exportName];
    if (typeof handler !== "function") {
      return { failed: true, detail: `export "${exportName}" is not a function`, output: "" };
    }
    const result: unknown = await handler(payload);
    return { failed: false, detail: "", output: typeof result === "string" ? result : JSON.stringify(result) };
  })().catch((err: unknown) => ({
    failed: true,
    detail: err instanceof Error ? err.message : String(err),
    output: "",
  }));

  // fn hooks run in-process and are not killable — a timer race is the only way to
  // report a hang without blocking the dispatcher forever. unref() so a hook that finishes
  // well under its (often 120s) timeout doesn't keep the CLI process alive waiting for it.
  let timer: NodeJS.Timeout;
  const timeout = new Promise<HookOutcome>((res) => {
    timer = setTimeout(() => res({ failed: true, detail: `timed out after ${timeoutMs}ms`, output: "" }), timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer!);
  }
};

type EntryRun = {
  readonly results: Readonly<Record<string, HookResult>>;
  readonly prompts: readonly PromptTodo[];
  readonly halt?: string;
};

// Called with each hook that failed, to fire hook-failed. `null` is how a run says it has no
// sink — the hook-failed run itself passes null, so a broken handler cannot loop back in.
type FailureSink = ((failure: HookFailure) => Promise<EntryRun>) | null;

// The name of an entry that failed to parse, for the skip row's key — undefined when the
// entry is too broken to have one, or when an earlier entry already claimed it.
const rawName = (raw: RawEntry): string | undefined => (isRecord(raw) && isStr(raw.name) ? raw.name : undefined);

const runEntries = async (
  entries: readonly RawEntry[],
  payload: Payload,
  deps: FireDeps,
  onFailure: FailureSink,
): Promise<EntryRun> => {
  const results: Record<string, HookResult> = {};
  const prompts: PromptTodo[] = [];
  // Names are tracked here, not read back out of `results`: a prompt hook never writes to
  // `results`, so inferring them from it lets a second entry reuse a prompt hook's name.
  const seen = new Set<string>();

  const absorb = (run: EntryRun): void => {
    for (const [key, value] of Object.entries(run.results)) results[`hook-failed:${key}`] = value;
    for (const todo of run.prompts) prompts.push({ ...todo, name: `hook-failed:${todo.name}` });
  };

  for (const [i, raw] of entries.entries()) {
    const parsed = parseEntry(raw, seen);
    if (!parsed.ok) {
      // A duplicate name would overwrite the entry that claimed it first, so those skips are
      // keyed by position instead.
      const name = rawName(raw);
      const key = name !== undefined && !seen.has(name) ? name : `${payload.event}#${i}`;
      results[key] = { status: "skipped", result: parsed.problems.join("; ") };
      continue;
    }

    const entry = parsed.value;
    if (!matchWhen(entry.when, payload)) continue;
    seen.add(entry.name);

    if ("prompt" in entry) {
      prompts.push({ name: entry.name, prompt: entry.prompt, payload, required: entry.required === true });
      continue;
    }

    const outcome = "cmd" in entry ? runCmd(entry, payload, deps) : await runFn(entry, payload, deps);

    if (outcome.failed) {
      const required = entry.required === true;
      results[entry.name] = { status: "failure", result: outcome.detail };
      if (onFailure !== null)
        absorb(await onFailure({ name: entry.name, event: payload.event, required, detail: outcome.detail }));
      if (!required) continue;
      return { results, prompts, halt: `HOOK_HALT ${entry.name}: ${outcome.detail}` };
    }
    results[entry.name] =
      entry.report === true ? { status: "success", result: outcome.output.trim() } : { status: "success" };
  }

  return { results, prompts };
};

export const runFire = async (flags: FireFlags, deps: FireDeps): Promise<Fired> => {
  const { hooks, raw, repoRoot } = loadHooks(deps.cwd);
  const entriesFor = (event: EventName): readonly RawEntry[] => [
    ...defaultHooks(event, raw),
    ...(hooks[event] ?? []),
  ];

  const onFailure: FailureSink = async (failure) =>
    runEntries(
      entriesFor("hook-failed"),
      buildPayload(
        {
          event: "hook-failed",
          ...(flags.stage !== undefined ? { stage: flags.stage } : {}),
          ...(flags.spec !== undefined ? { spec: flags.spec } : {}),
          data: { ...failure },
        },
        repoRoot,
        deps.cwd,
      ),
      deps,
      null,
    );

  const payload = buildPayload(flags, repoRoot, deps.cwd);
  const { results, prompts, halt } = await runEntries(entriesFor(flags.event), payload, deps, onFailure);
  return halt === undefined
    ? { out: buildOut(results, prompts) }
    : { out: buildOut(results, prompts, "halt", halt), halt };
};

const verdict = (results: Readonly<Record<string, HookResult>>, prompts: readonly PromptTodo[]): FireStatus => {
  const statuses = Object.values(results).map((r) => r.status);
  if (statuses.includes("failure")) return "failure";
  if (prompts.length > 0) return "success";
  return statuses.every((status) => status === "skipped") ? "skipped" : "success";
};

const buildOut = (
  results: Readonly<Record<string, HookResult>>,
  prompts: readonly PromptTodo[],
  status: FireStatus = verdict(results, prompts),
  result?: string,
): FireOutput => ({
  status,
  ...(result !== undefined ? { result } : {}),
  ...(Object.keys(results).length > 0 ? { results } : {}),
  ...(prompts.length > 0 ? { prompts } : {}),
});

const isEventName = (v: string): v is EventName => (EVENTS as readonly string[]).includes(v);
const isArtifactKind = (v: string): v is ArtifactKind => (KINDS as readonly string[]).includes(v);

export type DoctorReport = { readonly lines: readonly string[]; readonly failed: boolean };

const WHEN_KEYS: ReadonlySet<string> = new Set(["stage", "result", "kind"]);
// Events whose fire points pass no --stage, so a when.stage filter on them never matches.
// artifact-created belongs here for the same reason: all four of its fires (events.md) omit it.
const NO_STAGE_EVENTS: ReadonlySet<string> = new Set(["run-started", "run-completed", "artifact-created"]);

const doctorRow = (label: string, level: "OK" | "WARN" | "FAIL", detail?: string): string =>
  `${label.padEnd(28)} ${level}${detail !== undefined ? `: ${detail}` : ""}`;

const resolveFromRoot = (repoRoot: string, path: string): string => (isAbsolute(path) ? path : join(repoRoot, path));

// One row per hook entry (or per illegal event key), aligned like setup-harness's probe
// output. FAIL means the config cannot mean anything; WARN means it parses but almost
// certainly isn't what the author intended.
export const runDoctor = (cwd: string): DoctorReport => {
  const { hooks, repoRoot } = loadHooks(cwd);
  if (Object.keys(hooks).length === 0) {
    return { lines: [doctorRow("hooks", "OK", "no hooks configured")], failed: false };
  }

  const lines: string[] = [];
  let failed = false;

  for (const [event, entries] of Object.entries(hooks)) {
    const eventKnown = isEventName(event);
    if (!eventKnown) {
      lines.push(doctorRow(event, "FAIL", `unknown event "${event}"`));
      failed = true;
    }
    // Default hook names (only "notifier" today) are reserved on the events they could fire
    // on, whether or not the notifier is currently enabled — turning it on later shouldn't
    // silently steal a name a project already picked.
    const names = new Set<string>(eventKnown && NOTIFIER_EVENTS.has(event) ? ["notifier"] : []);

    entries.forEach((entry, i) => {
      const label = `${event}/${rawName(entry) ?? `#${i}`}`;
      const parsed = parseEntry(entry, names);
      // parseEntry owns every shape rule; the doctor adds only what it cannot know —
      // what exists on disk, and what can never fire.
      const fails: string[] = parsed.ok ? [] : [...parsed.problems];
      const warns: string[] = [];

      if (parsed.ok) {
        const e = parsed.value;
        if ("fn" in e && !existsSync(resolveFromRoot(repoRoot, e.fn.module))) {
          fails.push(`fn module not found: ${e.fn.module}`);
        }
        if ("prompt" in e) {
          if (!existsSync(resolveFromRoot(repoRoot, e.prompt))) {
            fails.push(`prompt file not found: ${e.prompt}`);
          }
          if (e.report === true) {
            warns.push("report on a prompt hook has no effect — a prompt's output is the agent's own");
          }
        }
        if (e.when !== undefined) {
          if (e.when.kind !== undefined && event !== "artifact-created") {
            warns.push("when.kind never fires on this event");
          }
          if (e.when.stage !== undefined && NO_STAGE_EVENTS.has(event)) {
            warns.push("when.stage never fires on this event — it carries no stage");
          }
        }
      }

      const name = rawName(entry);
      if (name !== undefined) names.add(name);

      if (fails.length > 0) {
        lines.push(doctorRow(label, "FAIL", fails.join("; ")));
        failed = true;
      } else if (warns.length > 0) {
        lines.push(doctorRow(label, "WARN", warns.join("; ")));
      } else {
        lines.push(doctorRow(label, "OK"));
      }
    });
  }

  return { lines, failed };
};

// Shared by every CLI command's argv parser: `--flag value` pairs, missing a value is an error.
function* flagPairs(argv: readonly string[]): Generator<readonly [string, string]> {
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag === undefined) return;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Flag "${flag}" is missing its value.`);
    yield [flag, value];
  }
}

export const parseFireArgv = (argv: readonly string[]): FireFlags => {
  let event: EventName | undefined;
  let stage: string | undefined;
  let result: "pass" | "fail" | undefined;
  let kind: ArtifactKind | undefined;
  let spec: string | undefined;
  let data: RawData | undefined;

  for (const [flag, value] of flagPairs(argv)) {
    switch (flag) {
      case "--event":
        if (!isEventName(value)) throw new Error(`Unknown --event "${value}". Supported: ${EVENTS.join(", ")}.`);
        event = value;
        break;
      case "--stage":
        stage = value;
        break;
      case "--result":
        if (value !== "pass" && value !== "fail") throw new Error('--result must be "pass" or "fail".');
        result = value;
        break;
      case "--kind":
        if (!isArtifactKind(value)) throw new Error(`Unknown --kind "${value}". Supported: ${KINDS.join(", ")}.`);
        kind = value;
        break;
      case "--spec":
        spec = value;
        break;
      case "--data": {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch (err) {
          throw new Error(`--data is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!isRecord(parsed)) throw new Error("--data must be a JSON object");
        data = parsed;
        break;
      }
      default:
        throw new Error(`Unknown flag "${flag}".`);
    }
  }

  if (event === undefined) throw new Error("--event is required.");

  // The same parse buildPayload will run, done here so a bad --data shape is rejected before
  // any hook fires — a rejected fire changed nothing, so the caller can fix the command and
  // send it again.
  const checked = (flags: FireFlags): FireFlags => {
    const check = parseData(flags, PARSE_ONLY_BASE);
    if (!check.ok) throw new Error(`--data does not fit --event ${flags.event}: ${check.problems.join("; ")}`);
    return flags;
  };

  const base = {
    ...(stage !== undefined ? { stage } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(spec !== undefined ? { spec } : {}),
    ...(data !== undefined ? { data } : {}),
  };

  if (event === "artifact-created") {
    if (kind === undefined) throw new Error("--event artifact-created requires --kind.");
    return checked({ event, kind, ...base });
  }
  if (kind !== undefined) throw new Error("--kind is only valid with --event artifact-created.");
  return checked({ event, ...base });
};

const defaultExec: Exec = (cmd, { input, timeoutMs }) => {
  try {
    const stdout = execSync(cmd, { input, timeout: timeoutMs, encoding: "utf8" });
    return { exit: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { exit: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

const defaultImportModule = (path: string): Promise<Record<string, unknown>> =>
  // Dynamic import of a variable path is always typed `any` by TS — this is the one place
  // that widens back to the declared shape.
  import(pathToFileURL(path).href) as Promise<Record<string, unknown>>;

const productionDeps = (): FireDeps => ({
  exec: defaultExec,
  importModule: defaultImportModule,
  cwd: process.cwd(),
});

// Every command answers on stdout with one JSON line carrying a `status`, so a caller parses
// the same shape whatever it asked for — and `invalid` is the only one that exits non-zero.
const say = (out: FireOutput): number => {
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return out.status === "invalid" ? 1 : 0;
};

const invalid = (message: string): number => {
  process.stderr.write(`hooks: ${message}\n`);
  return say({ status: "invalid", result: message });
};

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const runDoctorCommand = (cwd: string): number => {
  const { lines, failed } = runDoctor(cwd);
  for (const line of lines) process.stdout.write(`${line}\n`);
  return failed ? 1 : 0;
};

export const main = async (argv: readonly string[], deps: FireDeps = productionDeps()): Promise<number> => {
  const [command, ...rest] = argv;
  if (command === "doctor") return runDoctorCommand(deps.cwd);

  if (command !== "fire") {
    return invalid(`unknown command "${command ?? ""}". Supported: fire, doctor.`);
  }

  let flags: FireFlags;
  try {
    flags = parseFireArgv(rest);
  } catch (err) {
    return invalid(asMessage(err));
  }

  const { out, halt } = await runFire(flags, deps);
  if (halt !== undefined) process.stderr.write(`${halt}\n`);
  return say(out);
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
