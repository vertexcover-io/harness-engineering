import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type CheckContext, type Exec, execWithTimeout, type ITerminalHost } from "@harness/sdk";
import { captureLogger } from "../logging.ts";
import { claudeProvider } from "./claude.ts";
import TMUX_CONFIG from "./tmux.conf" with { type: "text" };
import { currentTerminal, tmuxHost } from "./tmux.ts";

const exec = execWithTimeout(10_000);
const FAKE_AGENT = join(import.meta.dirname, "fixtures", "fake-agent.ts");

const sockets: string[] = [];
afterEach(async () => {
  const toKill = sockets.splice(0);
  await Promise.all(
    toKill.map((socketName) => exec("tmux", ["-L", socketName, "kill-server"], process.cwd())),
  );
});

const makeSocket = (): { socketName: string; configPath: string } => {
  const socketName = `harness-test-${randomUUID()}`;
  sockets.push(socketName);
  const dir = mkdtempSync(join(tmpdir(), "harness-tmux-"));
  return { socketName, configPath: join(dir, "tmux.conf") };
};

const makeTerminal = (customExec: Exec = exec) => {
  const { socketName, configPath } = makeSocket();
  return {
    host: tmuxHost({ socketName, configPath, exec: customExec }),
    socketName,
    configPath,
  };
};

const countingExec = (real: Exec): { exec: Exec; sourceFileCalls: () => number } => {
  let count = 0;
  const wrapped: Exec = (command, args, cwd) => {
    if (args.includes("source-file")) count += 1;
    return real(command, args, cwd);
  };
  return { exec: wrapped, sourceFileCalls: () => count };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
};

const readLines = (path: string): Array<Record<string, unknown>> =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

describe("tmux.conf", () => {
  test("SC7a: holds the core settings, and pbcopy only where pbcopy exists", () => {
    for (const line of [
      "set -g prefix None",
      "set -g status off",
      "set -g allow-passthrough on",
      "bind -n 'C-\\' detach-client",
      'if-shell "command -v pbcopy" "set -s copy-command pbcopy"',
    ]) {
      expect(TMUX_CONFIG).toContain(line);
    }
  });
});

describe("tmuxTerminal.sendText logging", () => {
  test("SC38: the debug line has the text's length, not the text", async () => {
    const { log, lines } = captureLogger();
    const fakeExec: Exec = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
    const host = tmuxHost({
      socketName: "unused",
      configPath: "/tmp/unused.conf",
      exec: fakeExec,
      log,
    });

    await host.find("s1").sendText("SECRET_TEXT");

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("SECRET_TEXT");
    const debugLine = lines.find((line) => line.msg === "text typed into the session");
    expect(debugLine).toMatchObject({ session: "s1", chars: "SECRET_TEXT".length });
  });

  test("SC37: launching Claude through tmux logs no prompt, system prompt or env value", async () => {
    const { log, lines } = captureLogger();
    const failingExec: Exec = (_command, args) =>
      Promise.resolve(
        args.includes("new-session")
          ? { code: 1, stdout: "", stderr: "boom" }
          : { code: 0, stdout: "", stderr: "" },
      );
    const host = tmuxHost({
      socketName: "unused",
      configPath: join(mkdtempSync(join(tmpdir(), "harness-tmux-")), "tmux.conf"),
      exec: failingExec,
      log,
    });
    const provider = claudeProvider({ host, log, newId: () => "s1" });

    await provider.launch({
      cwd: "/repo",
      prompt: "SECRET_PROMPT",
      systemPrompt: "SECRET_SYS",
      env: { API_TOKEN: "SECRET_ENV" },
    });

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("SECRET");
    expect(lines.find((line) => line.msg === "tmux command failed")).toMatchObject({
      command: "new-session",
      session: "s1",
    });
  });
});

describe("tmux check", () => {
  const context = (result: { code: number; stdout: string }): CheckContext => ({
    root: "/repo",
    exec: () => Promise.resolve({ ...result, stderr: "" }),
  });
  const { host } = makeTerminal();
  const tmuxCheck = host.checks.find((check) => check.name === "tmux");
  if (!tmuxCheck) throw new Error("tmux check missing");

  test.each([
    ["tmux 3.2a\n", "fail"],
    ["tmux 3.6b\n", "ok"],
    ["tmux next-3.7\n", "ok"],
  ] as const)("SC5: %p gives %s", async (stdout, status) => {
    expect((await tmuxCheck.run(context({ code: 0, stdout }))).status).toBe(status);
  });
  test("SC5: a failing command fails with fix 'brew install tmux'", async () => {
    const outcome = await tmuxCheck.run(context({ code: 1, stdout: "" }));
    expect(outcome.status).toBe("fail");
    expect(outcome.fix).toEqual(["brew install tmux"]);
  });
});

const created = async (host: ITerminalHost, spec: Parameters<ITerminalHost["create"]>[0]) => {
  const result = await host.create(spec);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("tmuxHost against a real tmux", () => {
  test("SC2: create passes argv and env through to the child untouched", async () => {
    const { host } = makeTerminal();
    const outFile = join(mkdtempSync(join(tmpdir(), "fake-out-")), "out.jsonl");
    const weird = 'a "b" $c;d';

    const pane = await created(host, {
      name: `s-${randomUUID()}`,
      cwd: process.cwd(),
      argv: [FAKE_AGENT, weird],
      env: { FAKE_AGENT_OUT: outFile, K: "V" },
    });

    await waitFor(() => existsSync(outFile));
    const [record] = readLines(outFile);
    expect(record?.argv).toEqual([weird]);
    expect((record?.env as Record<string, string> | undefined)?.K).toBe("V");
    await pane.kill();
  });

  test("SC3: sendText then sendKeys(['Enter']) submits one line, keeping the word Enter literal", async () => {
    const { host } = makeTerminal();
    const outFile = join(mkdtempSync(join(tmpdir(), "fake-out-")), "out.jsonl");
    const pane = await created(host, {
      name: `s-${randomUUID()}`,
      cwd: process.cwd(),
      argv: [FAKE_AGENT],
      env: { FAKE_AGENT_OUT: outFile },
    });
    await waitFor(() => existsSync(outFile));

    await pane.sendText("Enter hello");
    await pane.sendKeys(["Enter"]);

    await waitFor(() => readLines(outFile).some((record) => record.line === "Enter hello"));
    await pane.kill();
  });

  test("SC4: a killed session is no longer alive or listed, whether reached by its pane or its name", async () => {
    const { host } = makeTerminal();
    const outFile = join(mkdtempSync(join(tmpdir(), "fake-out-")), "out.jsonl");
    const name = `s-${randomUUID()}`;
    const pane = await created(host, {
      name,
      cwd: process.cwd(),
      argv: [FAKE_AGENT],
      env: { FAKE_AGENT_OUT: outFile },
    });
    await waitFor(() => existsSync(outFile));

    expect(await pane.isAlive()).toBe(true);
    expect(await host.find(name).isAlive()).toBe(true);
    expect(await host.list()).toContain(name);

    const killed = await host.find(name).kill();
    expect(killed.ok).toBe(true);
    expect(await pane.isAlive()).toBe(false);
    expect(await host.list()).not.toContain(name);
  });

  test("kill closes only its own pane, so a second pane in the same session keeps running", async () => {
    const { host, socketName } = makeTerminal();
    const name = `s-${randomUUID()}`;
    const first = await created(host, { name, cwd: process.cwd(), argv: ["sleep", "60"], env: {} });
    const second = (
      await exec(
        "tmux",
        [
          "-L",
          socketName,
          "split-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          `=${name}:`,
          "sleep",
          "60",
        ],
        "/",
      )
    ).stdout.trim();

    expect((await first.kill()).ok).toBe(true);

    expect(await first.isAlive()).toBe(false);
    expect(await host.list()).toEqual([name]);
    const panes = await exec(
      "tmux",
      ["-L", socketName, "list-panes", "-a", "-F", "#{pane_id}"],
      "/",
    );
    expect(panes.stdout.trim()).toBe(second);
  });

  test("SC4: find matches the exact name, so s-1 never reaches the session s-10", async () => {
    const { host } = makeTerminal();
    await created(host, { name: "s-10", cwd: process.cwd(), argv: ["sleep", "60"], env: {} });
    expect(await host.find("s-1").isAlive()).toBe(false);
    expect((await host.find("s-1").sendText("x")).ok).toBe(false);
    expect(await host.find("s-10").isAlive()).toBe(true);
  });

  test("the attach command finds its session in tmux, by name and by the pane create returned", async () => {
    const { host } = makeTerminal();
    const name = `s-${randomUUID()}`;
    const pane = await created(host, { name, cwd: process.cwd(), argv: ["sleep", "60"], env: {} });
    const attach = async (argv: readonly string[]) => {
      const [command = "", ...args] = argv;
      return (await exec(command, args, "/")).stderr;
    };

    // Without a terminal on stdin, attach gets past finding the session and stops there.
    for (const argv of [host.find(name).attachCommand(), pane.attachCommand()]) {
      const stderr = await attach(argv);
      expect(stderr).toContain("not a terminal");
      expect(stderr).not.toContain("can't find");
    }
    expect(await attach(host.find(`${name}-gone`).attachCommand())).toContain("can't find session");
  });

  test("SC4: list is [] when no tmux server is running on the socket", async () => {
    const { host } = makeTerminal();
    expect(await host.list()).toEqual([]);
  });

  test("SC7b: the written config disables the prefix and status bar, and binds C-\\ to detach", async () => {
    const { host, socketName } = makeTerminal();
    const pane = await created(host, {
      name: `s-${randomUUID()}`,
      cwd: process.cwd(),
      argv: ["sleep", "60"],
      env: {},
    });

    const show = async (option: string): Promise<string> =>
      (
        await exec("tmux", ["-L", socketName, "show-options", "-g", option], process.cwd())
      ).stdout.trim();

    expect(await show("prefix")).toBe("prefix None");
    expect(await show("status")).toBe("status off");

    const rootKeys = (
      await exec("tmux", ["-L", socketName, "list-keys", "-T", "root"], process.cwd())
    ).stdout;
    expect(rootKeys).toContain("detach-client");
    await pane.kill();
  });

  test("SC7c: an older harness tmux gets its config rewritten and reloaded once, before the first create", async () => {
    const { socketName, configPath } = makeSocket();
    const dir = mkdtempSync(join(tmpdir(), "harness-tmux-old-"));
    const oldConfigPath = join(dir, "old.conf");
    writeFileSync(oldConfigPath, "set -g status on\n");
    await exec(
      "tmux",
      ["-L", socketName, "-f", oldConfigPath, "new-session", "-d", "-s", "seed", "sleep", "60"],
      process.cwd(),
    );

    const { exec: wrapped, sourceFileCalls } = countingExec(exec);
    const host = tmuxHost({ socketName, configPath, exec: wrapped });
    const spec = { cwd: process.cwd(), argv: ["sleep", "60"], env: {} };

    const first = await host.create({ name: `a-${randomUUID()}`, ...spec });
    const second = await host.create({ name: `b-${randomUUID()}`, ...spec });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(sourceFileCalls()).toBe(1);
    expect(readFileSync(configPath, "utf8")).toBe(TMUX_CONFIG);

    const status = (
      await exec("tmux", ["-L", socketName, "show-options", "-g", "status"], process.cwd())
    ).stdout;
    expect(status.trim()).toBe("status off");
  });

  test("SC7d: no harness tmux running yet: the config is written, never reloaded, and the fresh server has it", async () => {
    const { socketName, configPath } = makeSocket();
    const { exec: wrapped, sourceFileCalls } = countingExec(exec);
    const host = tmuxHost({ socketName, configPath, exec: wrapped });

    const result = await host.create({
      name: `s-${randomUUID()}`,
      cwd: process.cwd(),
      argv: ["sleep", "60"],
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(sourceFileCalls()).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(TMUX_CONFIG);

    const status = (
      await exec("tmux", ["-L", socketName, "show-options", "-g", "status"], process.cwd())
    ).stdout;
    expect(status.trim()).toBe("status off");
  });
});

describe("currentTerminal and rename", () => {
  test("SC6: the pane named by $TMUX and $TMUX_PANE reaches a session a -L host made, and renaming it keeps the pane reachable", async () => {
    const { host, socketName, configPath } = makeTerminal();
    const name = `s-${randomUUID()}`;
    const pane = await created(host, { name, cwd: process.cwd(), argv: ["sleep", "60"], env: {} });
    const socket = (
      await exec("tmux", ["-L", socketName, "display-message", "-p", "#{socket_path}"], "/")
    ).stdout.trim();
    const paneId = (
      await exec("tmux", ["-L", socketName, "list-panes", "-a", "-F", "#{pane_id}"], "/")
    ).stdout.trim();
    const harnessHome = dirname(configPath);

    const current = currentTerminal({
      TMUX: `${socket},1,0`,
      TMUX_PANE: paneId,
      HARNESS_HOME: harnessHome,
    });
    if (current === undefined) throw new Error("no current pane");
    expect(current.attachCommand()).toContain("-S");

    const renamed = await current.rename("claude-x-1234");
    expect(renamed.ok).toBe(true);
    expect(await host.list()).toEqual(["claude-x-1234"]);
    expect(await pane.isAlive()).toBe(true);
  });

  test("outside tmux there is no current pane", () => {
    expect(currentTerminal({})).toBeUndefined();
  });
});

describe("tmux pane respawn", () => {
  test("respawn replaces the program in a pane, keeping the pane id and the session name", async () => {
    const { host, socketName } = makeTerminal();
    const name = `s-${randomUUID()}`;
    const pane = await created(host, { name, cwd: process.cwd(), argv: ["sleep", "60"], env: {} });
    const paneOf = async () =>
      (
        await exec(
          "tmux",
          ["-L", socketName, "list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"],
          "/",
        )
      ).stdout.trim();
    const [paneId, pidBefore] = (await paneOf()).split(" ");

    const respawned = await pane.respawn({
      cwd: process.cwd(),
      argv: ["sh", "-c", 'echo "hello $GREETING"; sleep 60'],
      env: { GREETING: "world" },
    });

    expect(respawned.ok).toBe(true);
    const [paneAfter, pidAfter] = (await paneOf()).split(" ");
    expect(paneAfter).toBe(paneId);
    expect(pidAfter).not.toBe(pidBefore);
    expect(await host.list()).toEqual([name]);
    await sleep(300);
    const screen = await host.find(name).capture();
    expect(screen.ok ? screen.value : "").toContain("hello world");
  });
});
