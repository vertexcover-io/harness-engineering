# Don't nest ternaries

One `a ? b : c` is fine. A ternary inside another ternary is not: the reader has to count `?` and `:` to see which branch belongs to which test.

- When a value depends on more than two cases, use a `switch` or `if`/`return` instead.
  - For example, `executeNodes` picks a function by `node.type` with a `switch`, not with `node.type === "switch" ? … : node.type === "include" ? … : …`.
- A ternary next to `??` (`matched ?? (hasDefault ? "default" : undefined)`) counts as one level. Nest nothing further.

Source: review of `packages/core/src/workflow/next.ts`, PR #141.
