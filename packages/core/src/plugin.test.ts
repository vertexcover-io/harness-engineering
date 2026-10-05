import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "@yok/sdk";
import { installPlugin, pluginCheck } from "./plugin.ts";
import type { WorkflowAgent } from "./workflow/types.ts";

type Replies = Readonly<Record<string, Partial<ExecResult>>>;

// Answers each command by its args, joined with spaces; anything unlisted exits 0 with no output.
const recordingExec = (replies: Replies): { readonly exec: Exec; readonly calls: string[] } => {
  const calls: string[] = [];
  const exec: Exec = (_command, args) => {
    const key = args.join(" ");
    calls.push(key);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...replies[key] });
  };
  return { exec, calls };
};

const LIST = "plugin list --json";
const MARKETS = "plugin marketplace list --json";

const claudeEntry = (version: string, extra: Record<string, unknown> = {}) => ({
  id: "yok@yok",
  version,
  scope: "user",
  enabled: true,
  ...extra,
});

const codexEntry = (version: string, extra: Record<string, unknown> = {}) => ({
  name: "yok",
  marketplaceName: "yok",
  version,
  enabled: true,
  ...extra,
});

const listOf = (agent: WorkflowAgent, versions: readonly string[], disabled = false): string =>
  JSON.stringify(
    agent === "claude"
      ? versions.map((version) => claudeEntry(version, { enabled: !disabled }))
      : { installed: versions.map((version) => codexEntry(version, { enabled: !disabled })) },
  );

const AGENTS = ["claude", "codex"] as const;

describe("pluginCheck", () => {
  test("SC124: fails when the agent has no yok plugin turned on, and names the install command", async () => {
    for (const agent of AGENTS) {
      for (const stdout of [listOf(agent, []), listOf(agent, ["0.0.2"], true)]) {
        const { exec } = recordingExec({ [LIST]: { stdout } });
        const outcome = await pluginCheck(agent, "bin", "0.0.2", true).run({ root: "/p", exec });
        expect(outcome.status).toBe("fail");
        expect(pluginCheck(agent, "bin", "0.0.2", true).fix).toEqual([
          `yok plugin install --agent ${agent}`,
        ]);
      }
    }
  });

  test("SC125: fails on 0.0.1 turned on under a 0.0.2 binary, naming both and both fixes", async () => {
    for (const agent of AGENTS) {
      const { exec } = recordingExec({ [LIST]: { stdout: listOf(agent, ["0.0.1"]) } });
      const outcome = await pluginCheck(agent, "bin", "0.0.2", true).run({ root: "/p", exec });
      expect(outcome.status).toBe("fail");
      expect(outcome.detail).toContain("0.0.1");
      expect(outcome.detail).toContain("0.0.2");
      expect(outcome.fix).toEqual([
        `yok plugin install --agent ${agent}`,
        `yok update --agent ${agent}`,
      ]);
    }
  });

  test("SC126: passes on a matching user install and ignores a 0.0.1 install scoped to another project", async () => {
    const stdout = JSON.stringify([
      claudeEntry("0.0.2"),
      claudeEntry("0.0.1", { scope: "project", projectPath: "/other" }),
    ]);
    const { exec } = recordingExec({ [LIST]: { stdout } });
    const outcome = await pluginCheck("claude", "bin", "0.0.2", true).run({ root: "/p", exec });
    expect(outcome.status).toBe("ok");
  });

  test("SC127: passes in dev without asking the agent", async () => {
    const { exec, calls } = recordingExec({});
    const outcome = await pluginCheck("claude", "bin", "0.0.2", false).run({ root: "/p", exec });
    expect(outcome.status).toBe("ok");
    expect(calls).toEqual([]);
  });
});

const claudeMarket = (repo: string) => JSON.stringify([{ name: "yok", source: "github", repo }]);

const REPO_URL = "https://github.com/vertexcover-io/harness-engineering.git";

// The shape `codex plugin marketplace list --json` prints in Codex 0.159.3.
const codexMarket = (marketplaceSource: Readonly<Record<string, string>> | undefined): string =>
  JSON.stringify({
    marketplaces: [{ name: "yok", root: "/home/u/.codex/marketplaces/yok", marketplaceSource }],
  });

describe("installPlugin", () => {
  test("SC129: Claude at 0.0.1 gets this repo's yok marketplace replaced by one at v0.0.2", async () => {
    const { exec, calls } = recordingExec({
      [LIST]: { stdout: listOf("claude", ["0.0.1"]) },
      [MARKETS]: { stdout: claudeMarket("vertexcover-io/harness-engineering") },
    });

    const result = await installPlugin("claude", "claude", "0.0.2", exec, "/p");

    expect(calls).toEqual([
      LIST,
      MARKETS,
      "plugin marketplace remove yok",
      "plugin marketplace add vertexcover-io/harness-engineering#v0.0.2",
      "plugin install yok@yok",
    ]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toContain(
      "running sessions keep the old skills until /reload-plugins or a restart",
    );
  });

  test("SC130: Codex with no plugin and no marketplace adds one with --ref and installs through plugin add", async () => {
    const { exec, calls } = recordingExec({
      [LIST]: { stdout: listOf("codex", []) },
      [MARKETS]: { stdout: JSON.stringify({ marketplaces: [] }) },
    });

    const result = await installPlugin("codex", "codex", "0.0.2", exec, "/p");

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      LIST,
      MARKETS,
      "plugin marketplace add vertexcover-io/harness-engineering --ref v0.0.2",
      "plugin add yok --marketplace yok",
    ]);
  });

  test("Codex at 0.0.1 gets this repo's yok marketplace replaced by one at v0.0.2", async () => {
    const { exec, calls } = recordingExec({
      [LIST]: { stdout: listOf("codex", ["0.0.1"]) },
      [MARKETS]: { stdout: codexMarket({ sourceType: "git", source: REPO_URL }) },
    });

    const result = await installPlugin("codex", "codex", "0.0.2", exec, "/p");

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      LIST,
      MARKETS,
      "plugin marketplace remove yok",
      "plugin marketplace add vertexcover-io/harness-engineering --ref v0.0.2",
      "plugin add yok --marketplace yok",
    ]);
  });

  test("refuses a Codex yok marketplace that records no source and changes nothing", async () => {
    const { exec, calls } = recordingExec({
      [LIST]: { stdout: listOf("codex", []) },
      [MARKETS]: { stdout: codexMarket(undefined) },
    });

    const result = await installPlugin("codex", "codex", "0.0.2", exec, "/p");

    expect(result.ok).toBe(false);
    expect(calls).toEqual([LIST, MARKETS]);
  });

  test("SC131: does nothing past the list when Claude already has only 0.0.2 on", async () => {
    const { exec, calls } = recordingExec({ [LIST]: { stdout: listOf("claude", ["0.0.2"]) } });

    const result = await installPlugin("claude", "claude", "0.0.2", exec, "/p");

    expect(calls).toEqual([LIST]);
    expect(result).toEqual({ ok: true, value: "yok 0.0.2 is already installed for claude" });
  });

  test("SC132: refuses a yok marketplace pointing at someone/else and changes nothing", async () => {
    const { exec, calls } = recordingExec({
      [LIST]: { stdout: listOf("claude", []) },
      [MARKETS]: { stdout: claudeMarket("someone/else") },
    });

    const result = await installPlugin("claude", "claude", "0.0.2", exec, "/p");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("someone/else");
    expect(calls).toEqual([LIST, MARKETS]);
  });

  test("SC133: stops at a marketplace add that exits 1 with 'network down' and reports it", async () => {
    const { exec, calls } = recordingExec({
      [LIST]: { stdout: listOf("claude", []) },
      [MARKETS]: { stdout: "[]" },
      "plugin marketplace add vertexcover-io/harness-engineering#v0.0.2": {
        code: 1,
        stderr: "network down\nretry later",
      },
    });

    const result = await installPlugin("claude", "claude", "0.0.2", exec, "/p");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("plugin marketplace add");
    expect(!result.ok && result.error).toContain("network down");
    expect(calls).not.toContain("plugin install yok@yok");
  });
});
