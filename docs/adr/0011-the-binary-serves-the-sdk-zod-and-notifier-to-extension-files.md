---
status: active
date: 2026-10-03
source: .harness/yok-distribution/design.md, docs/plans/2026-10-02-yok-distribution-plan.md
tags: [harness-cli, sdk, run-hooks]
---

# The binary serves `@yok/sdk`, `zod` and `yok:notifier` to extension files itself; extensions need no node_modules

## Context and Problem Statement

Extension files (verifiers, schemas, hooks, skill `module:` files) import `@yok/sdk` and `zod`, but a user's project and the plugin's skill folder have no `node_modules`, and a compiled binary has no on-disk path for core's notifier to freeze into `state.json`.

## Considered Options

- At CLI start, before command dispatch, register one runtime Bun plugin that answers `@yok/sdk` (public entry only), `zod` and the reserved specifier `yok:notifier` from the binary's own modules; `state.json` freezes the built-in notifier as `yok:notifier`
- Extensions resolve `@yok/sdk` and `zod` from the project's own `node_modules`, with the SDK published to npm
- Bundle each extension with its dependencies before the binary loads it

## Decision Outcome

Chosen: the binary serves the three modules, because the extension's folder then needs nothing installed, the SDK an extension sees always matches the binary, and every extension shares the binary's one zod, so its schemas are the same zod instances the engine checks against. npm resolution needs an npm package and a package install per project, and lets the SDK and zod drift from the binary; per-extension bundling adds a build step users must run. `./internal` is never served, keeping ADR 0003's boundary. Core's notifier still reaches the SDK only as a frozen module reference (ADR 0006), now a reserved specifier instead of a file path.

## Consequences

Any package other than these three still needs the project's own `node_modules`; `importModule` must not look on disk for a `yok:` specifier.

This amends ADR 0006's "core's hooks reach the SDK only as frozen module paths": the built-in notifier is frozen as the reserved specifier `yok:notifier`, which the binary serves. Project hooks stay file paths.
