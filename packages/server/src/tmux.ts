/// <reference path="./tmux-conf.d.ts" />
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Check,
  type CheckContext,
  type Exec,
  execWithTimeout,
  fail,
  type ILogger,
  type ITerminal,
  noopLogger,
  type Outcome,
  ok,
  type Result,
  type TerminalSpec,
  warn,
} from "@harness/sdk";

// Bundled as text, so a compiled harness binary carries it too.
import TMUX_CONFIG from "./tmux.conf" with { type: "text" };

const MIN_VERSION = [3, 3] as const;

const parseVersion = (output: string): readonly [number, number] | null => {
  const match = /(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2])] : null;
};

const meetsMinimum = ([major, minor]: readonly [number, number]): boolean =>
  major > MIN_VERSION[0] || (major === MIN_VERSION[0] && minor >= MIN_VERSION[1]);

const checkTmux = async ({ exec, root }: CheckContext): Promise<Outcome> => {
  const { code, stdout } = await exec("tmux", ["-V"], root);
  if (code !== 0) return fail("not on PATH", ["brew install tmux"]);
  const detail = stdout.trim();
  const version = parseVersion(detail);
  if (version === null) return fail(`cannot parse "${detail}"`, ["brew install tmux"]);
  return meetsMinimum(version)
    ? ok(detail)
    : fail(`${detail} is older than 3.3`, ["brew install tmux"]);
};

const checkTmuxTerminfo = async ({ exec, root }: CheckContext): Promise<Outcome> => {
  const { code } = await exec("infocmp", ["tmux-256color"], root);
  return code === 0
    ? ok("tmux-256color")
    : warn("missing tmux-256color terminfo", ["use screen-256color"]);
};

const TMUX_CHECKS: readonly Check[] = [
  { name: "tmux", fix: ["brew install tmux"], run: checkTmux },
  { name: "tmux-terminfo", optional: true, fix: ["use screen-256color"], run: checkTmuxTerminfo },
];

export type TmuxTerminalOptions = Readonly<{
  socketName?: string;
  configPath: string;
  exec?: Exec;
  log?: ILogger;
}>;

const asError = (stderr: string): string => stderr.trim() || "tmux command failed";

// Arguments after the subcommand can carry a prompt, a system prompt or env values, so logs get
// the subcommand and its session, never the rest.
const targetOf = (args: readonly string[]): string | undefined => {
  const flag = args.findIndex((arg) => arg === "-t" || arg === "-s");
  return flag === -1 ? undefined : args[flag + 1]?.replace(/^=/, "");
};

const done = (result: Result<string>): Result<void> =>
  result.ok ? { ok: true, value: undefined } : result;

export const tmuxTerminal = ({
  socketName = "harness",
  configPath,
  exec = execWithTimeout(10_000),
  log: parentLog = noopLogger,
}: TmuxTerminalOptions): ITerminal => {
  const log = parentLog.child({ component: "tmux", socket: socketName });
  const baseArgs = ["-L", socketName, "-f", configPath];

  // `expected` marks a call whose failure is an ordinary answer, such as "no server yet" from
  // list-sessions, so it is not logged as an error.
  const run = async (args: readonly string[], expected = false): Promise<Result<string>> => {
    const start = Date.now();
    const { code, stdout, stderr } = await exec("tmux", [...baseArgs, ...args], process.cwd());
    const fields = {
      command: args[0],
      session: targetOf(args),
      code,
      durationMs: Date.now() - start,
    };
    if (code === 0) {
      log.debug(fields, "tmux command ran");
      return { ok: true, value: stdout };
    }
    if (expected) log.debug({ ...fields, stderr: stderr.trim() }, "tmux command answered no");
    else log.error({ ...fields, stderr: stderr.trim() }, "tmux command failed");
    return { ok: false, error: asError(stderr) };
  };

  const list = async (): Promise<readonly string[]> => {
    const result = await run(["list-sessions", "-F", "#{session_name}"], true);
    return result.ok
      ? result.value
          .trim()
          .split("\n")
          .filter((line) => line !== "")
      : [];
  };

  // Once per process: write the config, and reload it into a harness tmux that outlived an
  // earlier process. A fresh server picks up the file itself via -f on its first new-session.
  let setup: Promise<void> | null = null;
  const ensureSetup = (): Promise<void> => {
    if (setup === null) {
      setup = (async () => {
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, TMUX_CONFIG);
        log.debug({ path: configPath }, "tmux config written");
        if ((await list()).length > 0) {
          await run(["source-file", configPath]);
          log.info(
            { path: configPath },
            "tmux config reloaded into the already-running tmux server",
          );
        }
      })();
    }
    return setup;
  };

  const create = async (spec: TerminalSpec): Promise<Result<void>> => {
    await ensureSetup();
    const envArgs = Object.entries(spec.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const result = await run([
      "new-session",
      "-d",
      "-s",
      spec.name,
      "-x",
      "200",
      "-y",
      "50",
      "-c",
      spec.cwd,
      ...envArgs,
      "--",
      ...spec.argv,
    ]);
    if (result.ok) log.info({ session: spec.name, cwd: spec.cwd }, "tmux session created");
    return done(result);
  };

  const sendText = async (name: string, text: string): Promise<Result<void>> => {
    const result = await run(["send-keys", "-t", name, "-l", "--", text]);
    if (result.ok) log.debug({ session: name, chars: text.length }, "text typed into the session");
    return done(result);
  };

  const sendKeys = async (name: string, keys: readonly string[]): Promise<Result<void>> =>
    done(await run(["send-keys", "-t", name, ...keys]));

  const capture = async (name: string, lines = 40): Promise<Result<string>> => {
    const result = await run(["capture-pane", "-p", "-J", "-t", name, "-S", `-${lines}`]);
    return result.ok ? { ok: true, value: result.value.replace(/\s+$/, "") } : result;
  };

  const isAlive = async (name: string): Promise<boolean> =>
    (await run(["has-session", "-t", `=${name}`], true)).ok;

  const kill = async (name: string): Promise<Result<void>> => {
    const result = await run(["kill-session", "-t", `=${name}`]);
    if (result.ok) log.info({ session: name }, "tmux session killed");
    return done(result);
  };

  const attachCommand = (name: string): readonly string[] => [
    "tmux",
    ...baseArgs,
    "attach-session",
    "-t",
    `=${name}`,
  ];

  return {
    checks: TMUX_CHECKS,
    create,
    sendText,
    sendKeys,
    capture,
    isAlive,
    kill,
    list,
    attachCommand,
  };
};
