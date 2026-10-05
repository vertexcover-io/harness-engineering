import { setTimeout as sleep } from "node:timers/promises";
import {
  type AgentResult,
  type ILogger,
  type ITerminal,
  parseJson,
  type Result,
  type TerminalSpec,
} from "@yok/sdk";
import type * as z from "zod";

// An agent's TUI never returns while it is waiting for Enter to submit; the spike found 150ms reliable.
const SUBMIT_DELAY_MS = 150;

export const shellQuote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

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

// stdout/stderr can hold the agent's answer text, code, or secrets from the repo, so error
// messages carry only their size and a small prefix, never the full text.
export const summarize = (text: string): string =>
  `(${Buffer.byteLength(text)} bytes): ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;

export const parseJsonAnswer = <T>(
  agent: string,
  answer: string,
  outputFormat: z.ZodType<T>,
  sessionId: string,
): AgentResult<T> => {
  const json = parseJson(answer);
  if (!json.ok)
    return { ok: false, error: new Error(`${agent} result is not valid JSON`), sessionId };
  const parsed = outputFormat.safeParse(json.value);
  return parsed.success
    ? { ok: true, output: parsed.data, sessionId }
    : {
        ok: false,
        error: new Error(`${agent} result failed schema: ${parsed.error.message}`),
        sessionId,
      };
};

export const promptTerminal = async (
  terminal: ITerminal,
  text: string,
  log: ILogger,
): Promise<Result<void>> => {
  if (!(await terminal.isAlive())) {
    log.error({}, "prompt not sent: the session is not running");
    return { ok: false, error: "the agent's terminal is not running" };
  }
  const submitted = await typeLine(terminal, text);
  if (!submitted.ok) log.error({ err: submitted.error }, "prompt not sent");
  else log.info({ chars: text.length }, "prompt sent");
  return submitted;
};

export const stopTerminal = async (
  agent: string,
  terminal: ITerminal,
  log: ILogger,
): Promise<Result<void>> => {
  const result = await terminal.kill();
  if (result.ok) log.info({}, `${agent} session stopped`);
  else log.error({ err: result.error }, `${agent} session not stopped`);
  return result;
};

export const respawnAgent = async (
  agent: string,
  terminal: ITerminal,
  spec: Omit<TerminalSpec, "name">,
  log: ILogger,
): Promise<Result<void>> => {
  const respawned = await terminal.respawn(spec);
  if (respawned.ok) log.info({}, `${agent} relaunched in its pane`);
  else log.error({ err: respawned.error }, `${agent} not relaunched`);
  return respawned;
};
