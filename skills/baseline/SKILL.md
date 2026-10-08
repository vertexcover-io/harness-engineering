---
name: baseline
description: >
  Record how the project's checks stand before any code changes: run the config's baseline scripts
  in the run's workspace and save their output as the run's baseline artifact. Runs as the
  pipeline's baseline stage, right after the workspace exists.
mode: inline
allowed-tools: [Bash]
tier: fast
produces:
  - artifact: baseline
    optional: true
protocols: []
scopes: []
references:
  script:
    path: scripts/baseline.ts
    description: >
      The script that runs the baseline. A project replaces it with a JS or TS file that exports
      `main(argv)`, `extensions.baseline.references.script: { replace: PATH }`, or with a command in
      any language, `{ command: "python tools/baseline.py" }`; either gets the same flags and prints
      the same report.
---

# Baseline

The input may hold `packages`, a list of package names; with none, every package is baselined.
RUN below is the run's spec name.

## Steps

1. Run the baseline script, the `script` reference, with `--run RUN`, adding
   `--packages NAME1,NAME2` when the input has `packages`. It runs the project's replacement
   when it has one.

   It runs every script before it prints, which can take minutes. Run it in the background and
   wait for it to finish rather than cutting it off. If it cannot find the run, its config or the
   replacement, it exits non-zero; step 2 covers that.
2. If the command exits non-zero, stop and report the error exactly as it printed it, such as a
   script that is missing or a workspace that does not exist. Fixing the config is the person's
   call.
3. It prints `{ path, workspace, packages }`. A non-zero exit code inside it is not a failure of
   this stage: a suite that is already red is exactly what the baseline records. Name each script
   that exited non-zero when you report.
4. Reply with that JSON as the stage's output. When `path` is not null, finish the
   stage with `--artifact '{"type":"baseline","name":"baseline","path":"artifacts/baseline.json"}'`. When it is null, no baseline script ran:
   the chosen packages have no `baseline` command, or their worktrees are missing. Finish without
   an artifact.
