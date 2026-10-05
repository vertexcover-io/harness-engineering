import { Command } from "@commander-js/extra-typings";
import { claudeArgs } from "@yok/core";
import { spawnInteractive, yokHome } from "@yok/sdk";
import { devPluginDir, prependPath, selfArgv, writeShim } from "@yok/sdk/internal";

type Agent = "claude" | "codex";

const BINARY_ENV: Readonly<Record<Agent, string>> = {
  claude: "YOK_CLAUDE_BIN",
  codex: "YOK_CODEX_BIN",
};

const pluginArgs = (agent: Agent): readonly string[] => {
  const dir = devPluginDir();
  return agent === "claude" && dir !== undefined ? claudeArgs({ pluginDir: dir }) : [];
};

// Opens the agent with this program as its `yok`, the way `cargo +nightly` picks a toolchain.
export const agentCommand = (agent: Agent) =>
  new Command(agent)
    .description(`Open ${agent} with this yok as the session's yok command`)
    .argument("[args...]", `arguments passed to ${agent} unchanged`)
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args) => {
      const shimDir = writeShim(selfArgv(), yokHome());
      const binary = process.env[BINARY_ENV[agent]] ?? agent;
      process.exitCode = await spawnInteractive(binary, [...pluginArgs(agent), ...args], {
        cwd: process.cwd(),
        env: { PATH: prependPath(shimDir, process.env.PATH) },
      });
    });
