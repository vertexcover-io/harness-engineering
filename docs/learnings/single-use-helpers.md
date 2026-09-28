# Inline single-use helpers, unless they hold complex logic

A helper called from one place usually belongs in its caller. Too many tiny functions make the reader jump around to follow one flow.

- Inline a single-use helper when the caller stays short.
  - For example, `workspaceFolderOf` went into `resolveWorkspace`, and `toBaseline` went into `runScripts`.
- Keep it separate when it holds complex logic that is easier to read on its own, such as a rule with its own reasoning or a try/catch.
  - Its name must then say exactly what it does (`couldNotStart`, `parseJsonOrText`). A kept helper with a vague name is worse than inlining it.
- A helper used in two or more places stays (`isFolder`).

Source: review of `packages/core/src/stages/baseline.ts`, PR #142.
