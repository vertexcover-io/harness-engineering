---
title: "TypeScript: assemble discriminated unions from a satisfies table, not object spread"
date: 2026-02-14
category: design-patterns
tags: [typescript, discriminated-union, satisfies, object-spread, strict-mode, type-safety, no-casts]
component: skills/_shared/hooks.ts
severity: design
status: implemented
applies_to: ["skills/_shared/**/*.ts"]
stage: [code]
evidence_count: 1
last_validated: 2026-02-14
related: []
---

# TypeScript: assemble discriminated unions from a `satisfies` table, not object spread

## Problem

Building a discriminated-union payload from a runtime-selected member, without `as`. Two
obvious designs fail under `--strict --exactOptionalPropertyTypes`:

1. **Spread a union into a base** — `{ ...base, ...core }` where `core` is a union of
   event-tagged objects. TS does *not* distribute the spread; it flattens to one object
   whose `event` and `data` are unions of the members' types, which is not assignable to
   the union. (Verified: `TS2322` — `'"hook-failed" | ...' is not assignable to
   '"stage-completed"'`.)
2. **Generic assembler** — `const build = <E>(event: E, data: DataFor<E>) =>
   ({ ...base, event, data })`. Object literals don't check against `Extract<Union, {event: E}>`
   for generic `E`; it needs an `as` inside.

## Insight

**Let each table entry build the whole union member, and index the table by the union key —
the literal tags then check against concrete types inside the entries, and no cast exists
anywhere.**

A `satisfies`-typed object of per-key constructors, each returning its own concrete member
wrapped in a result type, collapses correctly when indexed by a union key: the indexed call's
return is the union of concrete results, which *is* assignable to the union-level result.

## Solution

```typescript
// file: skills/_shared/hooks.ts (abridged)
type PayloadFor<E extends LifecycleEvent> = Extract<LifecyclePayload, { event: E }>;
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };

const DATA = {
  "run-started": (b: PayloadBase, d: RawData): Parsed<RunStartedPayload> => {
    const problems: string[] = [];
    const data = textData(d, problems);           // validate + project untrusted JSON
    return problems.length > 0
      ? { ok: false, problems }
      : { ok: true, value: { ...b, event: "run-started", data } };  // literal tag, concrete type
  },
  // ... one entry per event, each with its own literal tag
} satisfies { readonly [E in LifecycleEvent]: (b: PayloadBase, d: RawData) => Parsed<PayloadFor<E>> };

// Index by the union key — no cast, returns Parsed<LifecyclePayload>:
const parseData = (flags: FireFlags, base: PayloadBase): Parsed<Payload> =>
  DATA[flags.event](base, flags.data ?? {});
```

`satisfies` (not a type annotation) is what makes it work: the table keeps its inferred
per-key types, so `DATA[event]` is a union of *precise* function types rather than one
generic signature.

## Prevention / Reuse

- Reaching for `as Payload` while assembling a union from parts → stop; try a table of
  per-key constructors typed with `satisfies { [K in Keys]: ... }` first.
- Verify the pattern in a scratch file with `tsc --strict --exactOptionalPropertyTypes`
  before committing to it (this repo has no tsconfig; `npx -y -p typescript tsc` works).
- The same table doubles as the untrusted-input parser: each entry validates its raw input
  and builds the member, so "parse once at the boundary, hand back a type that can't lie"
  falls out of the design.
