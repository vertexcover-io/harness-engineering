# Retro

If `CONFIG.stages.retro.disabled` is true, `set-status retro skipped` and go to Summary.
Otherwise `set-status retro running`; resolve the retro skill and model from [config.md](config.md)
and read [dispatch-preamble.md](dispatch-preamble.md).

Retro runs after the PR so the session transcript includes the whole implementation and shipping
sequence. Dispatch with:

```text
[PREAMBLE]

Invoke <SKILL:retro> with:
- Mode argument: <MODE_ARG>
- Session id: <SESSION_ID>
- Launch directory: <LAUNCH_DIR>
- Output dir: <HARNESS_DIR>/retro
- Spec name: <SPEC_NAME>
- Harness dir: <HARNESS_DIR>
- Plugin skills root: <plugin-root>/skills
- PR: <PR_URL>
- BRANCH: <BRANCH_NAME>
- BASE: <BASE_BRANCH>

Return issue count, MISSED count, and report path.
```

When `SESSION_ID` is empty, omit it and let the skill resolve the launch directory's newest
session. For a resumed run, audit each entry with its own paths and PR, keeping dashboard updates
on the primary run.

This stage cannot fail the run. On any error, `set-status retro failed`, print one line naming
the error, and continue to Summary with "not produced" in the retro row.
On success, `write-report retro`, then `set-status retro done`.
