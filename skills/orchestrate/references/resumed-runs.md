# Resumed runs

Read this when the caller supplies `TARGETS[]`. Each stage file carries its own resumed-run
deviation; this file carries the contract they share.

`coder` is the only entry stage. The caller supplies `TARGETS[]`, one checkout per entry:
`repository`, `worktree`, `branch`, `spec_name`, original `plan`, `base_sha`, and `packages`,
plus that entry's feedback. The first entry is primary and owns the dashboard and shared reports.
Each checkout resolves its own config and commands.
Assign each entry `TARGET_ID=target-<1-based index>` for filenames in shared report directories;
spec names can be identical across repositories.

After the doctor's verdict, use the caller's feedback as `TASK_CONTEXT` and skip fresh setup.
Capture `LAUNCH_DIR`, enter the primary worktree, and restore `WORKTREE_PATH`, `BRANCH_NAME`,
`SPEC_NAME`, `HARNESS_DIR`, session metadata, existing PR URLs, and target base branches from
the caller's run artifacts/PRs. Read each entry's config and resolve its environment.
Run the resume init block in [dashboard.md](dashboard.md#resumed-initialization), then enter the coder stage.
The caller has already captured and joined every baseline: preserve them and treat joins as complete.

Coder dispatches once per checkout in review-fix mode; its gate is a terminal disposition for every
feedback item, with no new phase E2E report required. Review runs once per entry; one verifier
sub-agent handles all entries, gating each against its own baseline. commit-pr commits/pushes the
set; Retro audits each entry. Scope each diff to its own `base_sha..HEAD` and use its original
plan, because a rework spec directory has no feature plan of its own.
