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

## Step 2: run the workflow one step at a time

Tell the user the run folder `init` printed (`dir`). Then repeat:

1. Run `bun run orchestrate next --run NAME`. It prints one JSON reply. Never run two `next`
   commands at the same time.
2. Act on the reply's `kind`:
   - `exec`: tell the user `▶ NODE_ID` (the reply's `nodeId`). Then run the reply's `command`
     exactly as printed.
     - `mode: inline`: run it in the foreground, with a 10-minute Bash timeout. When it
       returns, tell the user `✓ NODE_ID completed` or `✗ NODE_ID failed: MESSAGE`, from the
       printed JSON's `status` and `error.message`. A failed node exits non-zero; that is
       expected, so go back to 1. If the Bash call times out instead, no result was
       recorded and the node is still running: run the same `command` again as a
       background task, then go back to 1.
     - `mode: background`: the step is long, so run it as a background task to get past
       the Bash timeout. Nothing else runs meanwhile: wait for the task-finished notice, log
       `✓` or `✗` the same way, then go back to 1.
   - `stage`: tell the user `▶ NODE_ID (stage STAGE)`. Read the file at `skill`, then the file
     at `extension` when it is not null; where the extension conflicts with the skill, the
     extension wins. Follow the skill with the reply's `input` as its input, and `prompt` as
     extra instructions when present. When the skill needs one of its references, run
     `bun run orchestrate skill ref STAGE REF`, without `--run`, since references do not
     belong to a run; never open a reference file by its path, since
     that skips the project's changes to it. When the skill is done, run the reply's `done`
     command with `--output -`, plus `--artifact NAME=artifacts/PATH` for each artifact the
     skill wrote under `.harness/NAME/`, and pass the output JSON on stdin in a quoted heredoc:

     ```bash
     bun run orchestrate done NODE_RUN_ID --run NAME --output - <<'JSON'
     { "the": "skill's output" }
     JSON
     ```

     If the skill could not finish, pass `--error -` instead, with the reason in the heredoc.
     Always use the quoted heredoc (`<<'JSON'`), never text inside `'…'` on the command line:
     the shell leaves a quoted heredoc alone, while a single apostrophe in quoted text ends the
     quote and lets the rest run as shell. Log `✓` or `✗` from the printed JSON, then go back
     to 1.
   - `agent`: tell the user `▶ NODE_ID`. Do what `prompt` asks, with `input` as its data,
     then finish it with the reply's `done` command the same way as a stage.
   - `blocked`: the stage `stage` needs artifacts in `missing` that no finished node wrote.
     Tell the user which, and stop.
   - `waiting`: a step is still running, and only one step runs at a time. Wait for your
     background task to finish, then go back to 1. If none of your background tasks is
     still running, stop and report `nodeRunId`: its process ended
     without recording a result.
   - `finished`: tell the user the run ended with `status`, then stop.
3. On any non-zero exit from `next`, show its error output and stop.

`exec` and `done` record how each node ended. Never run `bun run orchestrate emit` for a node, and
never edit `.harness/NAME/state.json` or `.harness/NAME/event.jsonl` yourself.
