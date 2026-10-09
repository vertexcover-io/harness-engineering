# learn: simulated sessions

Real multi-turn sessions against a dummy repo, to test the learn skill end to end. `evals.json` checks
single prompts; these check what only a real session shows: whether a correction gets noticed,
whether the evidence ids point at the real messages, and whether the event reaches Samskara.

Each run:

1. `fixture.mjs` builds a fresh dummy monorepo in the temp folder: an admin API, an admin panel,
   and an installed shared settings package that already has the right place for a list both apps
   need, so the agent can plausibly get it wrong.
2. `run.mjs` drives the agent with `claude -p --plugin-dir <this plugin> --resume`, one call per user
   turn. A second model plays the user, from the scenario's task, what the user knows, and how they
   react; it answers what the agent actually said.
3. It then checks with code whether the mistake happened (from the agent's own writes and commands),
   and what the skill produced: the learning file and index line, the event fields, the evidence ids
   against the transcript, the trigger and its timing. A model grades only whether the learning says
   the intended lesson.
4. `samskara-check.mjs` (optional) enables the run's repo in a local Samskara with its own config,
   lets the real watcher upload, and checks the stored row and the evidence through the API.

## Running

```bash
node run.mjs <scenario> <outDir>              # one session
printf "auto-shared-list 1\nlint-path 1\n" | ./batch.sh   # several, 6 at a time, into $SIM_OUT
SAMSKARA_DIR=~/src/samskara.<worktree> node samskara-check.mjs <outDir>
RECHECK=1 node run.mjs <scenario> <outDir>    # re-run only the checks on a finished session
```

`node run.mjs` with no arguments lists the scenarios. `SIM_MODEL` picks the model for the
simulated user and the grader (default `sonnet`); `SIM_AGENT_MODEL` picks the agent under test
(default: the same).

## Before you run it

- **It costs real model calls.** One session is 4 to 12 agent turns plus as many user turns. The
  full set (about 34 sessions) took over an hour. Run it by hand, not in CI.
- **The agent runs with `--permission-mode bypassPermissions` under your real home folder.** Your
  user settings and plugins are not loaded (`--setting-sources project`), and it works in a temp
  repo, but it can read anything you can. In one run it looked in `~/projects` for a repo. Run it
  where that is acceptable, or under a separate user.
- Each run leaves its dummy repo in the temp folder and its session under `~/.claude/projects/`.
  Remove `learn-sim-*` folders from both when done.

See `../baseline.md` for what these runs measured.
