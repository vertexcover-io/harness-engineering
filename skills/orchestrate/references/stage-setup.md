# Setup

Run these steps in order. Script paths use `${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}`;
outside a plugin runtime, resolve the checkout's absolute path before changing directory.

1. **Run the doctor before creating the worktree or starting setup**, passing the raw argument through:

   ```bash
   node --experimental-strip-types "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}/skills/_shared/doctor.ts" "<raw argument>"
   ```

   Read its `ENVIRONMENT`, `INPUT`, and `VERDICT` sections. `READY` continues.
   A `harness-version` row whose fix runs `harness-update.ts` is handled before the verdict:
   `--pre-release` (`PRE_RELEASE=true`) wants the pre-release channel, a plain run the stable one.
   A FAIL row means the harness is behind its channel's pinned tag, or is on stable under
   `--pre-release`; run its fix command now. A WARN row means a plain run found a pre-release
   install; use `AskUserQuestion` to offer moving back to stable, and run the fix only if chosen.
   After `UPDATED`, tell the developer to run `/reload-plugins` and start orchestrate again, then
   stop: this session still runs the old harness. On `UPDATE_REFUSED` or `UPDATE_FAILED`, print the
   script's message and stop. Under `--auto`, never run the update; log the row and continue.
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
   When the ticket has an assignee, store their name as `TICKET_ASSIGNEE`.
   When the reader reports a ticket ID, store it as `TICKET_ID`.
   A resumed run uses the caller's feedback and follows [resumed-runs.md](resumed-runs.md)
   instead of steps 3–10.

3. **Name the run.** Derive `SPEC_NAME`: lowercase, spaces to hyphens, truncate to 30 characters.
   "Add user auth system" becomes `add-user-auth-system`. This is the only place it is derived.
   Capture `LAUNCH_DIR=$(pwd)` before any `cd`; transcripts belong to the launch directory.
   Resolve `SETUP_SCRIPT=<plugin-root>/skills/orchestrate/scripts/spec-setup.ts`.

4. **Load config** as `CONFIG`, per [config.md](config.md). Read it here, before the worktree
   exists, because the worktree stage resolves its skill from it. The doctor has already confirmed
   the file is present and parses. Resolve once and pass to command-running stages:
   `PACKAGES` = request-named keys, else every `CONFIG.packages` key whose `path` exists under
   `WORKTREE_PATH` (finalize after step 5; empty uses root commands);
   `ENVIRONMENT` = requested key, else `environments.default`. Baseline every candidate package:
   an omitted package blocks the gate later, while an extra package costs background time.

5. **Create the worktree.** Resolve the worktree skill per [config.md](config.md) and invoke it
   with `SPEC_NAME` and `BASE_BRANCH` (the requested target branch, otherwise `main`).
   Enter the checkout it produces and store `WORKTREE_PATH`, `BRANCH_NAME`, and `BASE_BRANCH`.
   Store `START_SHA=$(git rev-parse HEAD)` before any stage commits: commit-pr squashes the run's
   commits down to this point, and only this run's commits.
   If the skill fails or produces no usable worktree, stop and report the error and next action.

6. **Initialize the dashboard.** Run the init block in
   [dashboard.md](dashboard.md#initialization), store its `HARNESS_DIR` and `DAG_SCRIPT`,
   then `serve-start`, `set-status setup running`, `write-report worktree`,
   `set-status worktree done`. Init places `HARNESS_DIR` at the git top level
   If initialization fails, stop and report the command and error; preserve the worktree.

7. **Create the spec directory:**
   ```
   Bash("node --experimental-strip-types '<SETUP_SCRIPT>' init '<SPEC_NAME>' --custom-fields '{"worktree":"<WORKTREE_PATH>","branch":"<BRANCH_NAME>","ticket_id":"<TICKET_ID>","assignee":"<TICKET_ASSIGNEE>"}'")
   ```
   Always pass `worktree` and `branch`; the baseline runs package commands under that worktree.
   Drop the `ticket_id` key when there is no `TICKET_ID`, and `assignee` when there is no `TICKET_ASSIGNEE`.
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
   Store the background task handle. If the run halts before the join, stop this task first
   (`TaskStop` in Claude Code); the script kills its commands' workers when stopped.
   The script bootstraps packages, runs typecheck, lint and `test_all`, and writes
   `baseline.json`; red results are the baseline, and so is a command past its package's
   `timeoutSeconds` ([config.md](config.md#commands)), recorded as exit 124.
   Exit 2 halts with `CONFIG_STALE` (name the command, package, and config to update),
   `CONFIG_INVALID` (a `timeoutSeconds` that is not a positive number),
   `PACKAGE_UNKNOWN` (name the missing package and `setup-harness`), or `WORKTREE_MISSING`
   (the `worktree` passed at step 7 does not exist).

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
