import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type AgentResult,
  checkBinary,
  type Effort,
  type IAgentProvider,
  type ILogger,
  type ITerminal,
  type ITerminalHost,
  type LaunchOptions,
  noopLogger,
  type PermissionMode,
  parseJson,
  type Result,
  type RunRequest,
  spawn,
} from "@harness/sdk";
import * as z from "zod";
import { claudeSettings } from "./claude-hooks.ts";
import { limitMenuKeys, readResetWait } from "./claude-limit.ts";

// Claude never returns while it is waiting for Enter to submit; the spike found 150ms reliable.
const SUBMIT_DELAY_MS = 150;

// What Claude Code 2.1.285 shows in its pane. While it works, a spinner line (`✻ Compacting…`)
// or the hint under a queued prompt is on screen.
const SPINNER = /^[·✢✳✶✻✽*] \S.*…/;
export const CLAUDE_NOTHING_TO_COMPACT = "Not enough messages to compact.";
// Empties the input line; C-c would exit Claude when the box is already empty.
export const CLAUDE_CLEAR_INPUT_KEY = "C-u";

export const isClaudeBusy = (screen: string): boolean =>
  screen.includes("queued messages") || screen.split("\n").some((line) => SPINNER.test(line));

const RULE = /^\s*─{10,}\s*$/;
const DIALOG_FOOTER = /enter to confirm|esc to cancel/i;

// Claude's empty input box: a bare ❯ between two rules. A dialog replaces the box, so seeing it
// is the positive sign that Enter submits a message.
const hasEmptyInputBox = (screen: string): boolean =>
  screen
    .split("\n")
    .some(
      (line, i, lines) =>
        line.trim() === "❯" && RULE.test(lines[i - 1] ?? "") && RULE.test(lines[i + 1] ?? ""),
    );

const isAwaitingInput = (screen: string): boolean =>
  hasEmptyInputBox(screen) && !isClaudeBusy(screen) && !DIALOG_FOOTER.test(screen);

// On some versions Claude's limit menu has "Upgrade your plan" selected, so a bare Enter would buy
// an upgrade; this picks "Stop and wait" instead. Returns the screen to judge next: unchanged when
// no limit menu is open, re-read after answering it, or null for a menu it cannot answer safely.
// It answers once: a menu still open afterwards leaves no empty input, so nothing gets typed.
const answerLimitMenu = async (
  terminal: ITerminal,
  screen: string,
): Promise<Result<string | null>> => {
  const keys = limitMenuKeys(screen);
  if (keys === null) return { ok: true, value: null };
  if (keys.length === 0) return { ok: true, value: screen };
  const answered = await terminal.sendKeys(keys);
  if (!answered.ok) return answered;
  return terminal.capture();
};

const limitResetWait = async (terminal: ITerminal, message: string, now: Date) => {
  const screen = await terminal.capture();
  return readResetWait({ message, screen: screen.ok ? screen.value : "", now });
};

const promptWhenReady = async (
  terminal: ITerminal,
  text: string,
): Promise<Result<"sent" | "not-ready">> => {
  const captured = await terminal.capture();
  if (!captured.ok) return captured;
  const screen = await answerLimitMenu(terminal, captured.value);
  if (!screen.ok) return screen;
  if (screen.value === null || !isAwaitingInput(screen.value)) {
    return { ok: true, value: "not-ready" };
  }
  const cleared = await terminal.sendKeys([CLAUDE_CLEAR_INPUT_KEY]);
  if (!cleared.ok) return cleared;
  const typed = await typeLine(terminal, text);
  return typed.ok ? { ok: true, value: "sent" } : typed;
};

// Types `text` into a Claude pane or session and submits it with Enter.
export const typeLine = async (
  terminal: ITerminal,
  text: string,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<Result<void>> => {
  const typed = await terminal.sendText(text);
  if (!typed.ok) return typed;
  await wait(SUBMIT_DELAY_MS);
  return terminal.sendKeys(["Enter"]);
};

export type ClaudeArgOptions = Readonly<{
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  systemPrompt?: string;
  prompt?: string;
  orchestrateArgv?: readonly string[];
}>;

export const claudeArgs = (sessionId: string, options: ClaudeArgOptions): string[] => [
  "--session-id",
  sessionId,
  ...(options.model !== undefined ? ["--model", options.model] : []),
  ...(options.effort !== undefined ? ["--effort", options.effort] : []),
  ...(options.permissionMode !== undefined ? ["--permission-mode", options.permissionMode] : []),
  ...(options.systemPrompt !== undefined ? ["--append-system-prompt", options.systemPrompt] : []),
  ...(options.orchestrateArgv !== undefined
    ? ["--settings", JSON.stringify(claudeSettings(options.orchestrateArgv))]
    : []),
  ...(options.prompt !== undefined ? [options.prompt] : []),
];

export const claudeRunArgs = <T>(request: RunRequest<T>): string[] => [
  "-p",
  request.prompt,
  "--output-format",
  "json",
  ...(request.model !== undefined ? ["--model", request.model] : []),
  ...(request.effort !== undefined ? ["--effort", request.effort] : []),
  ...(request.systemPrompt !== undefined ? ["--append-system-prompt", request.systemPrompt] : []),
  ...(request.session?.mode === "resume" ? ["--resume", request.session.id] : []),
  ...(request.session?.mode === "fork" ? ["--resume", request.session.id, "--fork-session"] : []),
  ...(request.outputFormat !== undefined
    ? ["--json-schema", JSON.stringify(z.toJSONSchema(request.outputFormat))]
    : []),
];

// The claude binary's headless stdout shape; session_id is missing on some early failures.
const ClaudeCliOutputSchema = z.object({
  result: z.string(),
  session_id: z.string().optional(),
  is_error: z.boolean(),
});

// Logged in place of the full argv: prompt and system-prompt text can hold anything the user typed.
const REDACTED_RUN_FLAGS = new Set(["-p", "--append-system-prompt"]);
const redactRunArgs = (args: readonly string[]): string[] =>
  args.map((arg, i) => (REDACTED_RUN_FLAGS.has(args[i - 1] ?? "") ? "[redacted]" : arg));

export type ClaudeProviderOptions = Readonly<{
  host: ITerminalHost;
  log?: ILogger;
  binary?: string;
  newId?: () => string;
}>;

const parseResult = <T>(
  result: string,
  outputFormat: z.ZodType<T>,
  sessionId: string,
): AgentResult<T> => {
  const json = parseJson(result);
  if (!json.ok)
    return { ok: false, error: new Error("claude result is not valid JSON"), sessionId };
  const parsed = outputFormat.safeParse(json.value);
  return parsed.success
    ? { ok: true, output: parsed.data, sessionId }
    : {
        ok: false,
        error: new Error(`claude result failed schema: ${parsed.error.message}`),
        sessionId,
      };
};

// stdout/stderr can hold Claude's answer text, code, or secrets from the repo, so error
// messages carry only their size and a small prefix, never the full text.
const summarize = (text: string): string =>
  `(${Buffer.byteLength(text)} bytes): ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;

// Turns `claude -p --output-format json` stdout and its exit code into an AgentResult.
export const interpretOutput = <T>(
  { code, stdout, stderr }: Readonly<{ code: number; stdout: string; stderr: string }>,
  outputFormat?: z.ZodType<T>,
): AgentResult<T> => {
  const json = parseJson(stdout);
  if (!json.ok && code !== 0) {
    return {
      ok: false,
      error: new Error(`claude exited with code ${code} ${summarize(stderr.trim())}`),
    };
  }
  if (!json.ok) {
    return {
      ok: false,
      error: new Error(`claude produced invalid JSON output ${summarize(stdout)}`),
    };
  }
  const parsed = ClaudeCliOutputSchema.safeParse(json.value);
  if (!parsed.success) {
    return {
      ok: false,
      error: new Error(`claude output failed validation: ${parsed.error.message}`),
    };
  }

  const { result, session_id: sessionId, is_error: isError } = parsed.data;
  const withSession = sessionId !== undefined ? { sessionId } : {};
  if (code !== 0) {
    return { ok: false, error: new Error(`claude exited with code ${code}`), ...withSession };
  }
  if (isError) return { ok: false, error: new Error(result), ...withSession };
  if (sessionId === undefined) {
    return { ok: false, error: new Error("claude output is missing session_id") };
  }
  if (!outputFormat) return { ok: true, output: result as T, sessionId };
  return parseResult(result, outputFormat, sessionId);
};

export const claudeProvider = ({
  host,
  log: parentLog = noopLogger,
  binary = "claude",
  newId = randomUUID,
}: ClaudeProviderOptions): IAgentProvider => {
  const log = parentLog.child({ component: "claude" });

  const launch = async (
    options: LaunchOptions,
  ): Promise<Result<{ sessionId: string; terminal: ITerminal }>> => {
    const sessionId = newId();
    const sessionLog = log.child({ sessionId });
    const settings = {
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
    };
    const created = await host.create({
      name: sessionId,
      cwd: options.cwd,
      argv: [binary, ...claudeArgs(sessionId, options)],
      env: options.env ?? {},
    });
    if (!created.ok) {
      sessionLog.error({ err: created.error }, "claude not started: the terminal session failed");
      return created;
    }
    sessionLog.info(settings, "claude session started");
    return { ok: true, value: { sessionId, terminal: created.value } };
  };

  const relaunch = async (
    terminal: ITerminal,
    sessionId: string,
    options: LaunchOptions,
  ): Promise<Result<void>> => {
    const respawned = await terminal.respawn({
      cwd: options.cwd,
      argv: [binary, ...claudeArgs(sessionId, options)],
      env: options.env ?? {},
    });
    const sessionLog = log.child({ sessionId });
    if (respawned.ok) sessionLog.info({}, "claude relaunched in its pane");
    else sessionLog.error({ err: respawned.error }, "claude not relaunched");
    return respawned;
  };

  const prompt = async (terminal: ITerminal, text: string): Promise<Result<void>> => {
    if (!(await terminal.isAlive())) {
      log.error({}, "prompt not sent: the session is not running");
      return { ok: false, error: "the agent's terminal is not running" };
    }
    const submitted = await typeLine(terminal, text);
    if (!submitted.ok) {
      log.error({ err: submitted.error }, "prompt not sent");
      return submitted;
    }
    log.info({ chars: text.length }, "prompt sent");
    return submitted;
  };

  const stop = async (terminal: ITerminal): Promise<Result<void>> => {
    const result = await terminal.kill();
    if (result.ok) log.info({}, "claude session stopped");
    else log.error({ err: result.error }, "claude session not stopped");
    return result;
  };

  const run = async <T = string>(request: RunRequest<T>): Promise<AgentResult<T>> => {
    const args = claudeRunArgs(request);
    const startedAt = Date.now();

    const finish = (result: AgentResult<T>): AgentResult<T> => {
      const fields = {
        sessionId: result.sessionId,
        cwd: request.cwd,
        args: redactRunArgs(args),
        durationMs: Date.now() - startedAt,
      };
      if (result.ok) log.info(fields, "headless claude -p finished");
      else log.error({ ...fields, err: result.error }, "headless claude -p failed");
      return result;
    };

    const spawned = await spawn(binary, args, {
      cwd: request.cwd,
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.abortSignal === undefined ? {} : { signal: request.abortSignal }),
    });
    if (spawned.stopped === "aborted")
      return finish({ ok: false, error: new Error("run aborted") });
    return finish(interpretOutput(spawned, request.outputFormat));
  };

  return {
    type: "claude",
    checks: [
      {
        name: "claude",
        fix: ["npm i -g @anthropic-ai/claude-code"],
        run: checkBinary(binary),
      },
    ],
    launch,
    relaunch,
    prompt,
    stop,
    limitResetWait,
    promptWhenReady,
    run,
  };
};
