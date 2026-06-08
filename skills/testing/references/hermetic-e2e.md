# Hermetic E2E: self-provisioning, fail-fast, isolated

**Read this when** a project has (or needs) a browser/API e2e suite that talks to a real app + database. It is the antidote to the four failure modes that make e2e suites slow, flaky, and silently dead:

| Failure mode | Symptom in a run | Root cause |
|---|---|---|
| **Fixed-port wiring** | connection-refused, auth-failed, tests that pass alone but not together | App, DB, specs, and config each hardcode a port; they drift apart and collide across worktrees |
| **Manual infra** | Agent spends 30–60 min starting services, guessing ports, hand-seeding the DB | Tests assume "someone already started the stack" — nothing brings it up or proves it's up |
| **Slow hangs** | 120–360s stalls on a wrong selector or dead port | No fail-fast gate; per-test timeout is minutes, so every failure waits the full ceiling |
| **No isolation** | Specs pass in isolation, fail in the suite | All specs share one DB with no reset between them; seeded rows pollute later specs |

A correctly-built hermetic suite turns "one command, ~60 min of wrangling, flaky" into **"one command, fast bring-up, deterministic, self-cleaning."**

## The invariants (true for every stack)

1. **Ephemeral ports, allocated at runtime.** Never hardcode a host port. Bind to an OS-assigned free port and use it. With a per-worktree resource name, N worktrees run e2e concurrently with zero collisions.
2. **One source of truth.** Allocate ports/URLs/credentials **once**, export them, and have *every* consumer — app server, the test's seed client, the runner's base URL — read them. No spec carries a hardcoded fallback. Centralize them in one module every spec imports.
3. **Fail-fast gates, not long timeouts.** Every wait has a tight deadline (~20–30s) that **throws** with a clear message. Per-test/assertion timeouts in seconds, not minutes. A wrong selector or dead port must surface fast, never wait out a multi-minute ceiling.
4. **Per-spec isolation.** Each spec starts from a known state — truncate touched tables, roll back a per-test transaction, or use a fresh schema. A suite that resets per *run* (not per *spec*) passes file-by-file and fails as a whole.

## How to figure out the bring-up (don't assume a stack)

Derive every command from the repository. Answer these from the project, in order:

1. **What backing services does the app need?** Read the connection-string env keys (`*_URL`, `*_DSN`, `*_HOST`/`*_PORT`) in `.env*`/config, the service list in any compose/manifest file, and the clients the app imports. That set *is* your infra (DB, cache, queue, object store…).
2. **How does the project already start them?** Look for, and prefer, the project's own mechanism: a compose/orchestration file, an `infra`/`dev`/`db:setup` script, a Makefile target, an in-test Testcontainers/embedded-server setup. Reuse it — don't reinvent.
3. **How do you make the port collision-proof?** Find the env var/flag each service and the app read for their port, and pass a runtime-allocated free port instead of the default. (If the project hardcodes the port with no override, that's the bug to fix — add the override.)
4. **How do you know each piece is ready?** Find the readiness signal: a service's own readiness probe, or the app's health route (discover it from the route table). Poll it with a deadline; on miss, stop and surface the service log.
5. **How do you seed/reset data?** Prefer the project's migrate/seed/fixtures tooling over hand-rolled writes — a malformed hand seed makes the real code path fail and sends you debugging the wrong layer. Reset per spec (invariant 4).
6. **How do you run the tests against it?** The test-runner command, pointed at the allocated URLs/connection via the env from step 2's source of truth.
7. **How do you tear down?** Stop only what *you* started; leave anything that was already running.

The output of this is a single entrypoint (`test:e2e` or equivalent) that does 1→7 and is the only command anyone runs. Wire it into `package.json`/Makefile/justfile so the suite is hermetic from a cold checkout.

## Illustrative instantiation (one stack — copy the *shape*, not the commands)

> Node + Playwright + a container Postgres. A different stack (pytest + Testcontainers + Django, Go + dockertest, Rails + parallel test DBs) implements the same seven steps with its own tools.

```
entrypoint (run before the test runner):
  1. allocate free ports (bind :0) for each service + the app
  2. export connection env (DB url, cache url, app port, base url, credentials)
  3. start throwaway services on those ports (compose with an override, or `docker/podman run --rm`)
  4. fail-fast gates: each service's readiness probe, with a ~20s deadline → throw
  5. run migrations / seed via the project's own tooling
  6. exec the test runner (inherits the env); it starts the app on the allocated port
  7. finally: stop what you started

runner config:  reads ports/URLs from env only (no allocation, no infra). short per-test + assertion timeouts.
_infra module:  base URL, credentials, db-client factory — all from env, no fallbacks. Every spec imports it.
```

Two non-obvious traps worth checking on any framework:
- **Where in the lifecycle does infra come up vs. the app server?** Some runners start the app *before* their global-setup hook — so DB/cache bring-up cannot live in that hook; it must run in the entrypoint, before the runner. Verify the order for your runner.
- **Is config evaluated once or per worker?** If the runner re-imports the config in each worker process, allocating ports inside the config makes workers disagree. Allocate in the entrypoint; the config only *reads* env.
- **Does a one-off script resolve the project's DB driver?** In symlinked/monorepo layouts a bare `require('<driver>')` may not resolve. Invoke through the project's own tooling, or resolve the driver from the package that declares the dependency.

## Emit `e2e-report.json` (don't hand-author it)

The quality gate (Check 9) requires `.harness/runtime/<SPEC_NAME>/e2e-report.json` with `failed: 0`. Generate it from the framework's machine output (most runners have a JSON reporter), not by hand:

```json
{ "failed": 0, "passed": 12, "coverage": ["REQ-001", "REQ-002", "EDGE-003"],
  "gaps": ["EDGE-002 needs a live SMTP server — not covered in dev"],
  "timestamp": "<ISO>", "command": "<the e2e command>" }
```

`coverage` maps to REQ/EDGE IDs in the spec; `gaps` is the honest list of what the suite can't cover. Machine-generated removes the hand-edit churn and makes the gate trustworthy.

## Checklist before calling an e2e suite "done"

- [ ] No hardcoded host port or credential anywhere in `tests/` — a grep for the project's port range / `localhost:` comes back empty
- [ ] The e2e command brings up its own infra and tears it down (works from a cold checkout, no manual start first)
- [ ] Every wait fails fast (<30s) with a clear error
- [ ] Each spec passes **both** alone and inside the full suite (proves isolation)
- [ ] Runner emits `e2e-report.json`
