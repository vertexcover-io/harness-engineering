import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentResult,
  checkBinary,
  type IAgentProvider,
  type ILogger,
  type ITerminal,
  type ITerminalHost,
  type LaunchOptions,
  noopLogger,
  parseJson,
  type Result,
  type RunRequest,
  spawn,
} from "@yok/sdk";
import { VERSION } from "@yok/sdk/internal";
import * as z from "zod";
import { pluginCheck } from "../plugin.ts";
import { codexHookOverrides } from "./codex-hooks.ts";
import {
  parseJsonAnswer,
  promptTerminal,
  respawnAgent,
  stopTerminal,
  summarize,
  typeLine,
} from "./common.ts";

type CodexArgOptions = Pick<
  LaunchOptions,
  "model" | "effort" | "systemPrompt" | "prompt" | "orchestrateArgv"
>;

const configFlags = (overrides: readonly string[]): string[] =>
  overrides.flatMap((override) => ["-c", override]);

const settingFlags = ({
  model,
  effort,
  systemPrompt,
}: Pick<CodexArgOptions, "model" | "effort" | "systemPrompt">): string[] => [
  ...(model !== undefined ? ["-m", model] : []),
  ...configFlags([
    ...(effort !== undefined ? [`model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    ...(systemPrompt !== undefined
      ? [`developer_instructions=${JSON.stringify(systemPrompt)}`]
      : []),
  ]),
];

// Codex skips untrusted hooks, and the yok hooks arrive as -c overrides. The flag also covers
// hooks in the repo's own .codex/ config.
export const codexArgs = (options: CodexArgOptions): string[] => [
  "--dangerously-bypass-hook-trust",
  ...(options.orchestrateArgv !== undefined
    ? configFlags(codexHookOverrides(options.orchestrateArgv))
    : []),
  ...settingFlags(options),
  ...(options.prompt !== undefined ? [options.prompt] : []),
];

export const codexRunArgs = <T>(request: RunRequest<T>, schemaFile?: string): string[] => [
  "exec",
  ...(request.session !== undefined && request.session.mode !== "new"
    ? [request.session.mode]
    : []),
  "--json",
  "--skip-git-repo-check",
  ...settingFlags(request),
  ...(schemaFile !== undefined ? ["--output-schema", schemaFile] : []),
  ...(request.session !== undefined && request.session.mode !== "new" ? [request.session.id] : []),
  request.prompt,
];

const JsonlEventSchema = z.looseObject({
  type: z.string(),
  thread_id: z.string().optional(),
  message: z.string().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
  item: z.looseObject({ type: z.string(), text: z.string().optional() }).optional(),
});
type JsonlEvent = z.infer<typeof JsonlEventSchema>;

const parseEvents = (stdout: string): Result<JsonlEvent[]> => {
  const events: JsonlEvent[] = [];
  for (const raw of stdout.split("\n").filter((line) => line.trim() !== "")) {
    const json = parseJson(raw);
    const parsed = JsonlEventSchema.safeParse(json.ok ? json.value : undefined);
    if (!parsed.success) return { ok: false, error: "codex produced invalid JSONL output" };
    events.push(parsed.data);
  }
  return { ok: true, value: events };
};

const failureOf = (events: readonly JsonlEvent[]): string | undefined => {
  const failed = events.find((event) => event.type === "turn.failed" || event.type === "error");
  if (failed === undefined) return undefined;
  return failed.error?.message ?? failed.message ?? failed.type;
};

const answerOf = (events: readonly JsonlEvent[]): string | undefined =>
  events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .at(-1)?.item?.text;

export const interpretCodexOutput = <T>(
  { code, stdout, stderr }: Readonly<{ code: number; stdout: string; stderr: string }>,
  outputFormat?: z.ZodType<T>,
): AgentResult<T> => {
  const parsed = parseEvents(stdout);
  const events = parsed.ok ? parsed.value : [];
  const sessionId = events.find((event) => event.type === "thread.started")?.thread_id;
  const withSession = sessionId !== undefined ? { sessionId } : {};
  if (code !== 0) {
    return {
      ok: false,
      error: new Error(`codex exited with code ${code} ${summarize(stderr.trim())}`),
      ...withSession,
    };
  }
  if (!parsed.ok) return { ok: false, error: new Error(parsed.error) };
  const failure = failureOf(parsed.value);
  if (failure !== undefined) return { ok: false, error: new Error(failure), ...withSession };
  if (sessionId === undefined) {
    return { ok: false, error: new Error("codex output is missing thread.started") };
  }
  const answer = answerOf(parsed.value);
  if (answer === undefined) {
    return { ok: false, error: new Error("codex produced no answer"), sessionId };
  }
  if (!outputFormat) return { ok: true, output: answer as T, sessionId };
  return parseJsonAnswer("codex", answer, outputFormat, sessionId);
};

// Logged in place of the full argv: the prompt, last on the line, and developer instructions
// can hold anything the user typed.
export const redactCodexRunArgs = (args: readonly string[]): string[] =>
  args.map((arg, i) =>
    i === args.length - 1 || arg.startsWith("developer_instructions=") ? "[redacted]" : arg,
  );

// Only a bare › counts as an empty input box; a hint after it could also be typed-in text.
const EMPTY_INPUT = /^\s*›\s*$/;
const BUSY = /esc to interrupt/i;

const isAwaitingInput = (screen: string): boolean =>
  screen.split("\n").some((line) => EMPTY_INPUT.test(line)) && !BUSY.test(screen);

const statusLineOf = ({
  orchestrateArgv,
  env,
}: Pick<LaunchOptions, "orchestrateArgv" | "env">): readonly string[] | undefined => {
  const runId = env?.YOK_RUN_ID;
  if (orchestrateArgv === undefined || runId === undefined) return undefined;
  return [...orchestrateArgv, "statusline", "--run-id", runId];
};

// `codex exec --output-schema` takes a file path.
const writeSchema = async <T>(
  outputFormat: z.ZodType<T>,
): Promise<Readonly<{ dir: string; file: string }>> => {
  const dir = await mkdtemp(join(tmpdir(), "yok-codex-"));
  const file = join(dir, "schema.json");
  await writeFile(file, JSON.stringify(z.toJSONSchema(outputFormat)));
  return { dir, file };
};

export type CodexProviderOptions = Readonly<{
  host: ITerminalHost;
  log?: ILogger;
  binary?: string;
  newId?: () => string;
}>;

export const codexProvider = ({
  host,
  log: parentLog = noopLogger,
  binary = "codex",
  newId = randomUUID,
}: CodexProviderOptions): IAgentProvider => {
  const log = parentLog.child({ component: "codex" });

  const launch = async (
    options: LaunchOptions,
  ): Promise<Result<{ terminalName: string; terminal: ITerminal }>> => {
    const terminalName = newId();
    const sessionLog = log.child({ terminalName });
    const statusLine = statusLineOf(options);
    const created = await host.create({
      name: terminalName,
      cwd: options.cwd,
      argv: [binary, ...codexArgs(options)],
      env: options.env ?? {},
      ...(statusLine === undefined ? {} : { statusLine }),
    });
    if (!created.ok) {
      sessionLog.error({ err: created.error }, "codex not started: the terminal session failed");
      return created;
    }
    sessionLog.info({ cwd: options.cwd, model: options.model }, "codex session started");
    return { ok: true, value: { terminalName, terminal: created.value } };
  };

  const relaunch = async (
    terminal: ITerminal,
    sessionId: string,
    options: LaunchOptions,
  ): Promise<Result<void>> => {
    if (options.resume === true) {
      return { ok: false, error: "codex cannot resume a session in its pane" };
    }
    const spec = {
      cwd: options.cwd,
      argv: [binary, ...codexArgs(options)],
      env: options.env ?? {},
    };
    return respawnAgent("codex", terminal, spec, log.child({ sessionId }));
  };

  const prompt = (terminal: ITerminal, text: string): Promise<Result<void>> =>
    promptTerminal(terminal, text, log);

  const promptWhenReady = async (
    terminal: ITerminal,
    text: string,
  ): Promise<Result<"sent" | "not-ready">> => {
    const screen = await terminal.capture();
    if (!screen.ok) return screen;
    if (!isAwaitingInput(screen.value)) return { ok: true, value: "not-ready" };
    const typed = await typeLine(terminal, text);
    return typed.ok ? { ok: true, value: "sent" } : typed;
  };

  const stop = (terminal: ITerminal): Promise<Result<void>> => stopTerminal("codex", terminal, log);

  const run = async <T = string>(request: RunRequest<T>): Promise<AgentResult<T>> => {
    const startedAt = Date.now();
    const schema =
      request.outputFormat === undefined ? undefined : await writeSchema(request.outputFormat);
    try {
      const args = codexRunArgs(request, schema?.file);
      const spawned = await spawn(binary, args, {
        cwd: request.cwd,
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.abortSignal === undefined ? {} : { signal: request.abortSignal }),
      });
      const result: AgentResult<T> =
        spawned.stopped === "aborted"
          ? { ok: false, error: new Error("run aborted") }
          : interpretCodexOutput(spawned, request.outputFormat);
      const fields = {
        sessionId: result.sessionId,
        cwd: request.cwd,
        args: redactCodexRunArgs(args),
        durationMs: Date.now() - startedAt,
      };
      if (result.ok) log.info(fields, "headless codex exec finished");
      else log.error({ ...fields, err: result.error }, "headless codex exec failed");
      return result;
    } finally {
      if (schema !== undefined) await rm(schema.dir, { recursive: true, force: true });
    }
  };

  return {
    type: "codex",
    skillPrefix: "$",
    checks: [
      { name: "codex", fix: ["npm i -g @openai/codex"], run: checkBinary(binary) },
      pluginCheck("codex", binary, VERSION),
    ],
    launch,
    relaunch,
    prompt,
    stop,
    limitResetWait: () => Promise.resolve(null),
    promptWhenReady,
    run,
  };
};
