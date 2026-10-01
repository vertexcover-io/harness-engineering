/// <reference path="./tmux-conf.d.ts" />
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type Check,
  type CheckContext,
  type Exec,
  execWithTimeout,
  fail,
  harnessHome,
  type ILogger,
  type ITerminal,
  type ITerminalHost,
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

export type TmuxHostOptions = Readonly<{
  socketName?: string;
  socketPath?: string;
  configPath: string;
  exec?: Exec;
  log?: ILogger;
}>;

// One tmux server: how every command reaches it.
type TmuxSocket = Readonly<{ baseArgs: readonly string[]; exec: Exec; log: ILogger }>;

const tmuxSocket = ({
  socketName = "harness",
  socketPath,
  configPath,
  exec = execWithTimeout(10_000),
  log = noopLogger,
}: TmuxHostOptions): TmuxSocket => ({
  baseArgs: [
    ...(socketPath === undefined ? ["-L", socketName] : ["-S", socketPath]),
    "-f",
    configPath,
  ],
  exec,
  log: log.child({ component: "tmux", socket: socketPath ?? socketName }),
});

const asError = (stderr: string): string => stderr.trim() || "tmux command failed";

// "=name:" is how a pane is addressed by its session's exact name; logs show just the name.
const labelOf = (target: string): string => target.replace(/^=/, "").replace(/:$/, "");

// Arguments after the subcommand can carry a prompt, a system prompt or env values, so logs get
// the subcommand and its session, never the rest.
const targetOf = (args: readonly string[]): string | undefined => {
  const flag = args.findIndex((arg) => arg === "-t" || arg === "-s");
  const target = flag === -1 ? undefined : args[flag + 1];
  return target === undefined ? undefined : labelOf(target);
};

const done = (result: Result<string>): Result<void> =>
  result.ok ? { ok: true, value: undefined } : result;

const envArgs = (env: Readonly<Record<string, string>>): string[] =>
  Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);

// `expected` marks a call whose failure is an ordinary answer, such as "no server yet" from
// list-sessions, so it is not logged as an error.
const runTmux = async (
  { baseArgs, exec, log }: TmuxSocket,
  args: readonly string[],
  expected = false,
): Promise<Result<string>> => {
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

// One pane, at a tmux target that every command takes: a pane id such as %3, which survives a
// session rename, or =name: for the pane of the session named exactly `name`.
const tmuxPane = (socket: TmuxSocket, target: string): ITerminal => ({
  sendText: async (text) => {
    const result = await runTmux(socket, ["send-keys", "-t", target, "-l", "--", text]);
    if (result.ok)
      socket.log.debug(
        { session: labelOf(target), chars: text.length },
        "text typed into the session",
      );
    return done(result);
  },
  sendKeys: async (keys) => done(await runTmux(socket, ["send-keys", "-t", target, ...keys])),
  capture: async (lines = 40) => {
    const result = await runTmux(socket, [
      "capture-pane",
      "-p",
      "-J",
      "-t",
      target,
      "-S",
      `-${lines}`,
    ]);
    return result.ok ? { ok: true, value: result.value.replace(/\s+$/, "") } : result;
  },
  isAlive: async () => (await runTmux(socket, ["has-session", "-t", target], true)).ok,
  kill: async () => {
    // tmux ends the session with its last pane.
    const result = await runTmux(socket, ["kill-pane", "-t", target]);
    if (result.ok) socket.log.info({ pane: labelOf(target) }, "tmux pane killed");
    return done(result);
  },
  rename: async (name) => done(await runTmux(socket, ["rename-session", "-t", target, name])),
  respawn: async (spec) => {
    const args = ["respawn-pane", "-k", "-t", target, "-c", spec.cwd, ...envArgs(spec.env)];
    const result = await runTmux(socket, [...args, "--", ...spec.argv]);
    if (result.ok) socket.log.info({ pane: labelOf(target), cwd: spec.cwd }, "tmux pane respawned");
    return done(result);
  },
  attachCommand: () => ["tmux", ...socket.baseArgs, "attach-session", "-t", target],
});

export const tmuxHost = (options: TmuxHostOptions): ITerminalHost => {
  const socket = tmuxSocket(options);
  const { configPath } = options;

  const list = async (): Promise<readonly string[]> => {
    const result = await runTmux(socket, ["list-sessions", "-F", "#{session_name}"], true);
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
        socket.log.debug({ path: configPath }, "tmux config written");
        if ((await list()).length > 0) {
          await runTmux(socket, ["source-file", configPath]);
          socket.log.info(
            { path: configPath },
            "tmux config reloaded into the already-running tmux server",
          );
        }
      })();
    }
    return setup;
  };

  // -P prints the new pane's id, which stays the pane's address through a session rename.
  const create = async (spec: TerminalSpec): Promise<Result<ITerminal>> => {
    await ensureSetup();
    const size = ["-x", "200", "-y", "50"];
    const args = ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", spec.name, ...size];
    const result = await runTmux(socket, [
      ...args,
      "-c",
      spec.cwd,
      ...envArgs(spec.env),
      "--",
      ...spec.argv,
    ]);
    if (!result.ok) return result;
    socket.log.info({ session: spec.name, cwd: spec.cwd }, "tmux session created");
    return { ok: true, value: tmuxPane(socket, result.value.trim()) };
  };

  return {
    checks: TMUX_CHECKS,
    create,
    find: (name) => tmuxPane(socket, `=${name}:`),
    list,
  };
};

const configPathFor = (env: NodeJS.ProcessEnv): string => join(harnessHome(env), "tmux.conf");

// The tmux server `harness run` starts sessions on: HARNESS_TMUX_SOCKET, or `harness`.
export const harnessTmux = (env: NodeJS.ProcessEnv = process.env, log?: ILogger): ITerminalHost =>
  tmuxHost({
    socketName: env.HARNESS_TMUX_SOCKET ?? "harness",
    configPath: configPathFor(env),
    ...(log === undefined ? {} : { log }),
  });

// Inside a tmux pane, $TMUX starts with the server's socket path and $TMUX_PANE names the pane.
export const currentPane = (
  env: NodeJS.ProcessEnv = process.env,
  log?: ILogger,
): ITerminal | undefined => {
  const socketPath = env.TMUX?.split(",")[0];
  const pane = env.TMUX_PANE;
  if (!socketPath || !pane) return undefined;
  const options = { socketPath, configPath: configPathFor(env) };
  return tmuxPane(tmuxSocket(log === undefined ? options : { ...options, log }), pane);
};
