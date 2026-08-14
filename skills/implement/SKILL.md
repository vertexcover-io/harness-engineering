---
name: implement
description: Implement a plan, a phase file, or a described change by coding test-first. The single coding entry point — used manually, and dispatched as the orchestrate pipeline's coder stage.
---

Implement the work described in the phase file, the plan, or the user's request.

Use the `tdd` skill for every change — one behavior at a time, test first, at agreed seams.
Load `code-quality` before writing anything: it governs how the code reads.

While building, typecheck and run the affected test file often. Run the full suite once, at
the end.

Blocked — unclear instruction, missing dependency, a failing verification you can't explain?
Stop and ask rather than guess.

## Pipeline mode — when orchestrate dispatched you

You are in pipeline mode when the invocation hands you a `phases/phase-N.md`, or when it names a
worktree and a `.harness/<SPEC_NAME>/` to write artifacts into — the coder stage in the first case,
a review-fix agent in the second.

Two rules from the manual flow are **suspended**, in both cases:

- **Stage 4 owns review**, across the whole change rather than one phase — leave it there; a
  review agent reviewing here would be reviewing its own fixes.
- **Commit and keep going.** The pipeline runs to completion without pausing; a phase's
  `## Commit` section is its message.

**With a phase file, read `skills/orchestrate/references/coder-contracts.md` before you open any
source file.** It carries the phase-input mapping, the mandatory E2E leg and its gate, the report
ledger events (`check`, `artifact`, `end`). A phase
that ends without those events is blocked by `ledger state --assert coder`, however green its tests
are. A review-fix agent owes none of them — it is fixing inside phases that already reported.

## Manual mode — everything else

When green, use `code-review` to review the work. Ask before committing.
