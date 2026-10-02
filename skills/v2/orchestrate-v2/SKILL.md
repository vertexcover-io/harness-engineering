---
name: orchestrate-v2
description: >
  Runs a harness v2 workflow from inside the Claude Code or Codex session `harness run` launches.
  Not triggered by a user request — the harness server starts this skill directly as the
  session's first message, passing --workflow and --inputs.
---

# orchestrate-v2

`harness run` launches this session with `HARNESS_RUN_ID` and `HARNESS_HOME` already set in its
environment, then sends this skill as the first message.

Read the reference for the agent you are before Step 1: `references/claude-code.md` in Claude
Code, `references/codex.md` in Codex. It names the tools this skill refers to by what they do:
asking the user, running a long command in the background, keeping a task list, and resuming.

## Arguments

`--workflow PATH --inputs JSON [--name NAME]`, or `--resume NAME`

With `--resume NAME`, skip Step 1 (no `init`): tell the user the run is resuming, and go straight
to Step 2's loop with that `NAME`. The reference says how a resumed session receives it.

## Step 1: initialize the run

Use `--name` as the run name when supplied. Otherwise, derive a short kebab-case run name from
`inputs.prompt` when it is present, or from the workflow's name (the `--workflow` file's basename
without extension). Then run:

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
     - `mode: inline`: run it in the foreground, with a 10-minute timeout. When it
       returns, tell the user `✓ NODE_ID completed` or `✗ NODE_ID failed: MESSAGE`, from the
       printed JSON's `status` and `error.message`. A failed node exits non-zero; that is
       expected, so go back to 1. If the command times out instead, no result was
       recorded and the node is still running: run the same `command` again as a
       background task (see the reference), then go back to 1.
     - `mode: background`: the step is long, so run it as a background task to get past
       the timeout. Nothing else runs meanwhile: wait for the task to finish, log
       `✓` or `✗` the same way, then go back to 1.
   - `stage`: tell the user `▶ NODE_ID (stage STAGE)`. Read the file at `skill`, then the file
     at `extension` when it is not null; where the extension conflicts with the skill, the
     extension wins. Follow the skill with the reply's `input` as its input, `variables` as the
     values of the variables the skill names, and `prompt` as extra instructions when present.
     When the skill needs one of its references, run
     `bun run orchestrate skill ref STAGE.REF`. It needs no `--run`: it finds the run through
     `HARNESS_RUN_ID` and reads the config that run started with. Never open a reference file by
     its path, since that skips the project's changes to it. When the skill is done, run the reply's `done`
     command with `--output -`, plus `--artifact NAME=artifacts/PATH` for each artifact the
     skill wrote under `.harness/NAME/`, and pass the output on stdin in a quoted heredoc. The
     output is JSON when the skill declares `outputs` (or the node an `output` schema), and plain
     text otherwise:

     ```bash
     bun run orchestrate done NODE_RUN_ID --run NAME --output - <<'OUT'
     { "the": "skill's output" }
     OUT
     ```

     If the skill could not finish, pass `--error -` instead, with the reason in the heredoc.
     Always use the quoted heredoc (`<<'OUT'`), never text inside `'…'` on the command line:
     the shell leaves a quoted heredoc alone, while a single apostrophe in quoted text ends the
     quote and lets the rest run as shell. If `done --output` exits non-zero, read its JSON error.
     When `retryable` is `true`, fix the command input or each issue in `issues` and retry `done`
     with the same `nodeRunId`; the node is still running. An issue of kind `verifier` or
     `verifier-error` is a stage check that failed: read its `findings` or `message`, fix the
     work, and call `done` again. The third rejected `done` on a node fails it for good
     (`verify-exhausted`): log `✗` and go back to 1, since `next` decides whether that failure
     ends the run (a node with `allowFailure` lets it go on). On any other error whose
     `retryable` is `false`, stop and report the error. Do not call `next` until `done` reports
     completed, reports `verify-exhausted`, or you report an unrecoverable stage error with
     `done --error`. Log `✓` or `✗` from the printed JSON, then go back to 1.
   - `agent`: tell the user `▶ NODE_ID`. Do what `prompt` asks, with `input` as its data,
     then finish it with the reply's `done` command the same way as a stage.
   - `context`: tell the user `↻ NODE_ID: ACTION` (the reply's `nodeId` and `action`, e.g.
     `↻ fresh: new`), then end the turn at once, without running any other command. The work
     starts once the turn is over: for `new` the harness replaces this session with a fresh one,
     and for `compact` it compacts this session. Either way the session then receives
     the skill's `--resume NAME` message and carries on. Codex has no context steps: the Stop
     hook completes the node as not applied and sends you back to `next`.
   - `blocked`: the stage `stage` needs artifacts in `missing` that no finished node wrote.
     Tell the user which, and stop.
   - `waiting`: a step is still running, and only one step runs at a time. Wait for your
     background task to finish, then go back to 1. If none of your background tasks is
     still running, stop and report `nodeRunId`: its process ended
     without recording a result.
   - `finished`: tell the user the run ended with `status`, then stop.
3. Mirror each `exec`, `stage` and `agent` node into your task list (the reference names the
   tool), without spending a turn on it: make each task call in the same step as a command you run
   anyway. Create a task named `NODE_ID` beside the `▶` log, mark it in progress beside the node's
   first command, and mark it completed beside the next `next`. On `✗`, leave it open with a note
   that it failed. After `--resume` the list starts empty.
4. On any non-zero exit from `next`, show its error output and stop.

`exec` and `done` record how each node ended. Never run `bun run orchestrate emit` for a node, and
never edit `.harness/NAME/state.json`, `.harness/NAME/event.jsonl` or the harness `registry.json`
yourself: a hook refuses any tool call that writes, moves or deletes them, and its message names
the command to use instead. Reading them is fine.

When you need the user's input, ask the way the reference says. A Stop hook checks the run when
your turn ends, and a turn that ends with a node still open, or before `next`, is sent back to
you with the command you still owe.
