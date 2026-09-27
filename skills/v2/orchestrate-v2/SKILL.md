---
name: orchestrate-v2
description: >
  Runs a harness v2 workflow from inside the Claude Code session `harness run` launches. Not
  triggered by a user request — the harness server starts this skill directly as the session's
  first message, passing --workflow and --inputs.
---

# orchestrate-v2

`harness run` launches this session with `HARNESS_RUN_ID` and `HARNESS_HOME` already set in its
environment, then sends this skill as the first message.

## Arguments

`--workflow PATH --inputs JSON`

## Step 1: initialize the run

Derive a short kebab-case run name: from `inputs.prompt` when it is present, otherwise from the
workflow's name (the `--workflow` file's basename without extension). Then run:

```
bun run orchestrate init NAME
```

`init` reads `HARNESS_RUN_ID` from this session's environment, so no `--run-id` flag is needed.
Every later action on the run names it by `NAME` (`--run NAME`), not by its id. On a non-zero
exit, show the command's error output and stop — do not retry with a different name.

## Step 2: report and stop

Tell the user the run folder `init` printed (`dir`), then stop. Later plans add the steps
that actually run the workflow.
