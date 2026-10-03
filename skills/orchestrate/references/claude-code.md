# orchestrate in Claude Code

Read this when you are Claude Code. It names the tools that SKILL.md describes by what they do.

- **Asking the user:** use `AskUserQuestion`. Never end your turn with a question in plain text.
- **Long commands:** an inline `exec` runs through the Bash tool with `timeout: 600000`. A
  `mode: background` command, or an inline one that timed out, runs with Bash's
  `run_in_background: true`. Claude Code sends a task-finished notice when it ends; wait for it.
- **Task list:** mirror nodes with `TaskCreate` and `TaskUpdate`, or `TodoWrite` where those are
  absent. Give each task `activeForm: "Running NODE_ID"`. Send each task call in the same message
  as a command you run anyway.
- **Resume:** a resumed or replaced session receives `/orchestrate --resume NAME` as its
  first message.
