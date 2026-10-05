import { Command } from "@commander-js/extra-typings";
import { agentBinary, claudeArgs, type WorkflowAgent } from "@yok/core";
import { spawnInteractive, yokHome } from "@yok/sdk";
import { devPluginDir, prependPath, selfArgv, writeShim } from "@yok/sdk/internal";

const pluginArgs = (agent: WorkflowAgent): readonly string[] => {
  const dir = devPluginDir();
  return agent === "claude" && dir !== undefined ? claudeArgs({ pluginDir: dir }) : [];
};

// Opens the agent with this program as its `yok`, the way `cargo +nightly` picks a toolchain.
export const agentCommand = (agent: WorkflowAgent) =>
  new Command(agent)
    .description(`Open ${agent} with this yok as the session's yok command`)
    .argument("[args...]", `arguments passed to ${agent} unchanged`)
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args) => {
      const shimDir = writeShim(selfArgv(), yokHome());
      const binary = agentBinary(agent, process.env);
      process.exitCode = await spawnInteractive(binary, [...pluginArgs(agent), ...args], {
        cwd: process.cwd(),
        env: { PATH: prependPath(shimDir, process.env.PATH) },
      });
    });
