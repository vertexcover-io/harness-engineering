import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { captureLogger } from "@harness/core";
import { type CheckContext, type Exec, execWithTimeout } from "@harness/sdk";
import { claudeProvider } from "./claude.ts";
import TMUX_CONFIG from "./tmux.conf" with { type: "text" };
import { tmuxTerminal } from "./tmux.ts";

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
    terminal: tmuxTerminal({ socketName, configPath, exec: customExec }),
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
    const terminal = tmuxTerminal({
      socketName: "unused",
      configPath: "/tmp/unused.conf",
      exec: fakeExec,
      log,
    });

    await terminal.sendText("s1", "SECRET_TEXT");

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
    const terminal = tmuxTerminal({
      socketName: "unused",
      configPath: join(mkdtempSync(join(tmpdir(), "harness-tmux-")), "tmux.conf"),
      exec: failingExec,
      log,
    });
    const provider = claudeProvider({ terminal, log, newId: () => "s1" });

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
  const { terminal } = makeTerminal();
  const tmuxCheck = terminal.checks.find((check) => check.name === "tmux");
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

describe("tmuxTerminal against a real tmux", () => {
  test("SC2: create passes argv and env through to the child untouched", async () => {
    const { terminal } = makeTerminal();
    const outFile = join(mkdtempSync(join(tmpdir(), "fake-out-")), "out.jsonl");
    const name = `s-${randomUUID()}`;
    const weird = 'a "b" $c;d';

    const result = await terminal.create({
      name,
      cwd: process.cwd(),
      argv: [FAKE_AGENT, weird],
      env: { FAKE_AGENT_OUT: outFile, K: "V" },
    });

    expect(result.ok).toBe(true);
    await waitFor(() => existsSync(outFile));
    const [record] = readLines(outFile);
    expect(record?.argv).toEqual([weird]);
    expect((record?.env as Record<string, string> | undefined)?.K).toBe("V");
    await terminal.kill(name);
  });

  test("SC3: sendText then sendKeys(['Enter']) submits one line, keeping the word Enter literal", async () => {
    const { terminal } = makeTerminal();
    const outFile = join(mkdtempSync(join(tmpdir(), "fake-out-")), "out.jsonl");
    const name = `s-${randomUUID()}`;
    await terminal.create({
      name,
      cwd: process.cwd(),
      argv: [FAKE_AGENT],
      env: { FAKE_AGENT_OUT: outFile },
    });
    await waitFor(() => existsSync(outFile));

    await terminal.sendText(name, "Enter hello");
    await terminal.sendKeys(name, ["Enter"]);

    await waitFor(() => readLines(outFile).some((record) => record.line === "Enter hello"));
    await terminal.kill(name);
  });

  test("SC4: a killed session is no longer alive or listed", async () => {
    const { terminal } = makeTerminal();
    const outFile = join(mkdtempSync(join(tmpdir(), "fake-out-")), "out.jsonl");
    const name = `s-${randomUUID()}`;
    await terminal.create({
      name,
      cwd: process.cwd(),
      argv: [FAKE_AGENT],
      env: { FAKE_AGENT_OUT: outFile },
    });
    await waitFor(() => existsSync(outFile));

    expect(await terminal.isAlive(name)).toBe(true);
    expect(await terminal.list()).toContain(name);

    const killed = await terminal.kill(name);
    expect(killed.ok).toBe(true);
    expect(await terminal.isAlive(name)).toBe(false);
    expect(await terminal.list()).not.toContain(name);
  });

  test("SC4: list is [] when no tmux server is running on the socket", async () => {
    const { terminal } = makeTerminal();
    expect(await terminal.list()).toEqual([]);
  });

  test("SC7b: the written config disables the prefix and status bar, and binds C-\\ to detach", async () => {
    const { terminal, socketName } = makeTerminal();
    const name = `s-${randomUUID()}`;
    await terminal.create({ name, cwd: process.cwd(), argv: ["sleep", "60"], env: {} });

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
    await terminal.kill(name);
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
    const terminal = tmuxTerminal({ socketName, configPath, exec: wrapped });

    const first = await terminal.create({
      name: `a-${randomUUID()}`,
      cwd: process.cwd(),
      argv: ["sleep", "60"],
      env: {},
    });
    const second = await terminal.create({
      name: `b-${randomUUID()}`,
      cwd: process.cwd(),
      argv: ["sleep", "60"],
      env: {},
    });

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
    const terminal = tmuxTerminal({ socketName, configPath, exec: wrapped });

    const name = `s-${randomUUID()}`;
    const result = await terminal.create({
      name,
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

describe("tmuxTerminal socketPath and rename", () => {
  test("SC6: a terminal built with socketPath reaches the server a -L terminal made, and rename works on a pane id", async () => {
    const { terminal, socketName, configPath } = makeTerminal();
    const name = `s-${randomUUID()}`;
    await terminal.create({ name, cwd: process.cwd(), argv: ["sleep", "60"], env: {} });
    const socket = (
      await exec("tmux", ["-L", socketName, "display-message", "-p", "#{socket_path}"], "/")
    ).stdout.trim();
    const pane = (
      await exec("tmux", ["-L", socketName, "list-panes", "-a", "-F", "#{pane_id}"], "/")
    ).stdout.trim();

    const bySocket = tmuxTerminal({ socketPath: socket, configPath });
    expect(await bySocket.list()).toEqual([name]);
    expect(bySocket.attachCommand(name)).toContain("-S");

    const renamed = await bySocket.rename(pane, "claude-x-1234");
    expect(renamed.ok).toBe(true);
    expect(await terminal.list()).toEqual(["claude-x-1234"]);
  });
});

describe("tmuxTerminal respawn", () => {
  test("respawn replaces the program in a pane, keeping the pane id and the session name", async () => {
    const { terminal, socketName } = makeTerminal();
    const name = `s-${randomUUID()}`;
    await terminal.create({ name, cwd: process.cwd(), argv: ["sleep", "60"], env: {} });
    const paneOf = async () =>
      (
        await exec(
          "tmux",
          ["-L", socketName, "list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"],
          "/",
        )
      ).stdout.trim();
    const [pane, pidBefore] = (await paneOf()).split(" ");

    const respawned = await terminal.respawn(pane as string, {
      cwd: process.cwd(),
      argv: ["sh", "-c", 'echo "hello $GREETING"; sleep 60'],
      env: { GREETING: "world" },
    });

    expect(respawned.ok).toBe(true);
    const [paneAfter, pidAfter] = (await paneOf()).split(" ");
    expect(paneAfter).toBe(pane);
    expect(pidAfter).not.toBe(pidBefore);
    expect(await terminal.list()).toEqual([name]);
    await sleep(300);
    const screen = await terminal.capture(name);
    expect(screen.ok ? screen.value : "").toContain("hello world");
  });
});
