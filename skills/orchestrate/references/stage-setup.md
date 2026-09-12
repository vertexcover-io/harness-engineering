# Setup

Run these steps in order. Script paths use `${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}`;
outside a plugin runtime, resolve the checkout's absolute path before changing directory.

1. **Run the doctor before creating the worktree or starting setup**, passing the raw argument through:

   ```bash
   node --experimental-strip-types "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}/skills/_shared/doctor.ts" "<raw argument>"
   ```

   Read its `ENVIRONMENT`, `INPUT`, and `VERDICT` sections. `READY` continues.
   For `DEGRADED <names>`, print the WARN rows and fixes, then use `AskUserQuestion`:
   fix now (invoke `setup-harness`, rerun doctor), continue without, or stop.
   Record skipped capabilities: `gh` means no PR, `samskara` means no publish.
   For `BLOCKED <names>`, print the FAIL rows and fixes, name `setup-harness`, and stop;
   a project doctor row is the project's to fix. Apply the entrypoint's mode overrides.
   Wait for a degradation choice before proceeding; choosing stop ends the run. Before a
   worktree exists, report the result without dashboard commands or run hooks.

2. **Read INPUT.** Store the doctor's `AUTO_MODE`, `INPUT_KIND`, and `INPUT_REF`.
   For `prompt`, use the stripped argument; for `ticket`, fetch its title and description
   through the project's tracker reader (carry the URL as context if none can read it);
   for `file`, read its contents. Store the result as `TASK_CONTEXT` for every stage.
   A resumed run uses the caller's feedback and follows [resumed-runs.md](resumed-runs.md)
   instead of steps 3–10.

3. **Name the run.** Derive `SPEC_NAME`: lowercase, spaces to hyphens, truncate to 30 characters.
   "Add user auth system" becomes `add-user-auth-system`. This is the only place it is derived.
   Capture `LAUNCH_DIR=$(pwd)` before any `cd`; transcripts belong to the launch directory.
   Resolve `SETUP_SCRIPT=<plugin-root>/skills/orchestrate/scripts/spec-setup.ts`.

4. **Load config** as `CONFIG`, per [config.md](config.md). Read it here, before the worktree
   exists, because the worktree stage resolves its skill from it. The doctor has already confirmed
   the file is present and parses. Resolve once and pass to command-running stages:
   `PACKAGES` = request-named keys, else every `CONFIG.packages` key (empty uses root commands);
   `ENVIRONMENT` = requested key, else `environments.default`. Baseline every candidate package:
   an omitted package blocks the gate later, while an extra package costs background time.

5. **Create the worktree.** Resolve the worktree skill per [config.md](config.md) and invoke it
   with `SPEC_NAME` and `BASE_BRANCH` (the requested target branch, otherwise `main`).
   Enter the checkout it produces and store `WORKTREE_PATH`, `BRANCH_NAME`, and `BASE_BRANCH`.
   If the skill fails or produces no usable worktree, stop and report the error and next action.

6. **Initialize the dashboard inside the worktree.** Run the init block in
   [dashboard.md](dashboard.md#initialization), store its `HARNESS_DIR` and `DAG_SCRIPT`,
   then `serve-start`, `set-status setup running`, `write-report worktree`,
   `set-status worktree done`. Init uses cwd; starting it here keeps dashboard and artifacts together.
   If initialization fails, stop and report the command and error; preserve the worktree.

7. **Create the spec directory:**
   ```
   Bash("node --experimental-strip-types '<SETUP_SCRIPT>' init '<SPEC_NAME>'")
   ```
   It creates the artifact directories (`verify-staging/` beside `verification/`), clears a
   stale baseline, and writes the manifest. Store printed `SPEC_DIR`, `BASELINE_PATH`,
   `MANIFEST_PATH`; read `SESSION_ID` from `run_info.session` (empty is valid).
   Exit 2 with `CONFIG_MISSING` halts and names `setup-harness`.
   Any other init error or missing required setup output stops the stage with the script's error.

8. **Fire `run-started` before any other event**, following the lifecycle fire table in
   [events.md](events.md). The manifest step 7 wrote must exist first — it is where the notifier
   records the run's thread.
   ```
   <HOOKS> fire --event run-started --spec <SPEC_NAME> --data '{"title":"<SPEC_NAME>","body":"<one-line task> : <ticket URL>"}'
   ```

9. **Start the baseline.** `set-status setup done`, `set-status baseline running`, then:
   ```
   Bash("node --experimental-strip-types '<SETUP_SCRIPT>' baseline '<SPEC_NAME>' --packages '<PACKAGES>'", run_in_background: true)
   ```
   Store the background task handle. The script bootstraps packages, runs typecheck, lint and
   `test_all`, and writes `baseline.json`; red results are the baseline.
   Exit 2 halts with `CONFIG_STALE` (name the command, package, and config to update) or
   `PACKAGE_UNKNOWN` (name the missing package and `setup-harness`).

10. **Enter the planning stage without waiting.**

## The join

Orchestrate waits for the baseline exactly once: when planning returns, before any stage edits
source. Planning takes minutes of conversation, so the baseline is normally done by then; the
implement route is the one path that returns fast, and it goes through the same wait.

Wait for the background task to finish and read its exit code. A non-zero exit halts with its
printed code, or `BASELINE_UNUSABLE` otherwise. If the exit code was lost to compaction, check
file presence after the task has ended: the script writes `baseline.json` last, so present means
finished; absent means `BASELINE_UNUSABLE`. Then `write-report baseline` and
`set-status baseline done`.
