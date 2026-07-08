# E2E Through a Consumer Repo

Some phases change a **published library component** — code that ships as a package (`@scope/lib`)
and is *rendered/executed by a separate host app*, not run standalone. A UI component library, a
shared SDK, a schema package: the library repo has no route, no server, no browsable surface of its
own. You cannot drive its behavior end-to-end from inside the library repo.

For these, the altitude splits across two repos:

- **Unit tests stay in the library repo.** Assert on the changed **pure exported helpers** directly.
  If the library has no render/integration harness wired (no RTL, no server), do **not** try to
  mount the component there — extract the logic to an exported function and test that. These are
  the phase's `### Unit` scenarios.
- **The E2E leg runs in the consumer repo** — the host app that imports and mounts the library on a
  real, drivable surface (a route, a CLI entry, an HTTP handler). That is the only place the full
  journey exists. This is the phase's `### E2E` scenario, and it is a `type: "ui"` (or `type: "api"`)
  claim, re-proven downstream against the consumer.

## The rule

**When the code under test is a published library consumed by a host app, the E2E runs in the
consumer repo where it is mounted — never in the library repo.** The library repo owns unit
coverage of its exported logic; the consumer owns the end-to-end proof.

## The sync precondition — non-negotiable

A consumer repo resolves the library from its **installed `node_modules` copy** (the registry-
published build), **not** from your worktree source. So an E2E driving your change will silently
render the *old published* code and either fail confusingly or pass while proving nothing.

**Before any consumer-repo E2E is trusted, sync the worktree build into the consumer's
`node_modules`:**

1. Build the library's publishable output from the worktree (`npm run build` → its `dist`, or the
   raw config/JSON for a data package).
2. Copy that output over the consumer's installed copy
   (`<consumer>/node_modules/@scope/<lib>/…`) — dist for a compiled package, the changed files for
   a data package. (Equivalently `yalc push` / `npm link` if the repo is set up for it.)
3. Only then run the consumer's E2E.

A green consumer E2E run *before* this sync is invalid — record it as not-yet-proven, not PASS.

**The consumer's library copy must be a real, isolated directory — never a symlink to the master
checkout.** When you set up worktrees, do not point `<consumer>/node_modules/@scope/<lib>` at the
master repo (a symlink or `cp -R` of master's symlink farm): the sync in step 2 would then overwrite
the *shared* master install, corrupting it for every other checkout — so you can't sync, and the E2E
silently gets skipped or downgraded. If you find it symlinked, replace it with a real isolated copy
before syncing. If you genuinely cannot produce a syncable isolated copy, the E2E is **BLOCKED** — say
so and return control; do **not** skip it, and do **not** re-home the scenario to unit altitude to
claim done. An unsyncable consumer is a blocked precondition, exactly like a missing token below.

## Install preconditions

The consumer (and often the library) may have **no `node_modules`** — run `npm install` first.
Scoped `@scope/*` packages frequently resolve from a private registry (e.g. GitHub Packages),
which needs an auth token in the environment; without it, install fails. Surface a missing token as
a blocked precondition, not a test failure.

## What goes where

| Fact | Layer |
|------|-------|
| *This* feature's unit-in-library / E2E-in-consumer split, and which consumer | the phase file's `### Unit` / `### E2E` scenarios |
| Per-repo command, test-file glob, harness availability, install/token needs | that repo's `CLAUDE.md` (feature-independent) |
| The rule above + the sync precondition | this reference |

Do not restate the per-repo commands here — read them from the repo's `CLAUDE.md`. This reference
owns only the cross-repo *rule* and the *sync* step.
