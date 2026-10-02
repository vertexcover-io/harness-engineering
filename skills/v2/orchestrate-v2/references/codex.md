# orchestrate-v2 in Codex

Read this when you are Codex. It names the tools that SKILL.md describes by what they do. Items
marked unverified come from Codex's documentation and were not run against a live harness session.

- **Invoking:** Codex finds this skill under `.agents/skills/` and the harness starts it with
  `$orchestrate-v2 --workflow PATH --inputs JSON`. A resumed session receives
  `$orchestrate-v2 --resume NAME`.
- **Asking the user:** Codex has no `AskUserQuestion` tool. End the turn with one direct question.
  The Stop hook sends the turn back once if a node is still open; ask the same question again and
  the second stop goes through. Between nodes, a turn that ran no orchestrate command is treated
  as a chat with the user and is not sent back. Unverified: a structured question tool, which
  Codex offers only in some modes, would also work.
- **Long commands:** run an inline `exec` as a normal shell call and allow it up to 10 minutes.
  For a `mode: background` command, or an inline one that timed out, start it as a long-running
  shell command and poll it until it ends. Unverified: Codex's background-process behavior varies
  by version; if it cannot background a command, run it in the foreground.
- **Task list:** keep the list with `update_plan`, one item per node named `NODE_ID`. Call it in
  the same turn step as a command you run anyway.
- **Context steps:** not supported. A `context` node is completed as not applied for you.
