---
name: implement
description: Implement a plan or a described change by coding test-first. The manual coding entry point.
disable-model-invocation: true
---

Implement the work described in the plan or the user's request.

Use the `tdd` skill for every change — one behavior at a time, test first, at agreed seams.
Load `code-quality` before writing anything: it governs how the code reads.

While building, typecheck and run the affected test file often. Run the full suite once, at
the end.

Blocked — unclear instruction, missing dependency, a failing verification you can't explain?
Stop and ask rather than guess.

When green, use `code-review` to review the work. Ask before committing.
