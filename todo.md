# To do

## Let expressions reach nodes inside a container

An expression can only read sibling nodes today: `nodes.X` finds a node in the same list, never
one inside an include, switch or loop. A container's output is the output of its last node, so
the other inner nodes cannot be read from outside at all.

Add a path that walks in by id, for example:

```yaml
input:
  review: "{{ nodes.wrap-up.nodes.review.output }}"
  draft: "{{ nodes.route.nodes.docs-draft.output }}"
```

Walking by container keeps ids unique only within their own list, so an included workflow can
reuse ids. The expression reader is `readNode` in `packages/core/src/workflow/evaluate.ts`.

## Don't lose a step's reply when its log event fails

When `next`, `exec` or `done` works but storing its `orchestrate.*` event fails, the call exits 1
and the skill never sees the reply, though the step itself was recorded. Print the reply anyway
and warn that the log failed. See `logCall` in `packages/core/src/runs.ts`.
