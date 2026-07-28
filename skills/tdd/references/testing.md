# Writing Good Tests

**Read this when** writing or reviewing any test. This is the standard for what a test must
prove. The `tdd` skill owns *when* tests get written; `code-quality` owns how test code reads —
a test file is held to the same bar as source.

Tests exist to answer one question: **"Does this code do the right thing?"**

Not "does it call the right functions," not "does it follow a certain code path." Just: does it
produce the correct outcome for a given input?

---

## Before Writing Any Tests

### 1. Assess testability

Read the code. Ask: **Is this code easy to test as-is?**

If no, **stop**: name the barrier from the table and suggest the refactoring that removes it.

| Problem | Why It's Hard to Test | Refactoring Direction |
|---------|----------------------|----------------------|
| Hidden dependencies (constructors create collaborators) | Can't substitute dependencies | Inject via constructor/function parameters |
| Global state or singletons | Tests interfere with each other | Pass state explicitly; dependency injection |
| Large functions doing many things | Too many scenarios to cover | Extract smaller, single-purpose functions |
| Deep inheritance hierarchies | Unclear what behavior belongs where | Favor composition over inheritance |
| Side effects mixed with logic | Can't test logic without triggering side effects | Separate pure logic from I/O |
| Direct calls to external systems | Tests become slow and flaky | Wrap behind an interface/abstraction |
| Tight coupling between modules | Changing one thing breaks everything | Define clear boundaries and interfaces |

**Present the user with the refactoring suggestions before proceeding** — name the barrier and
what the refactored version enables. Let the user decide whether to refactor first or proceed
as-is.

For legacy code: write a **characterization test** capturing current behavior as a safety net,
refactor, then replace it with proper behavior tests.

### 2. Assess what test level is needed

**Signals that unit tests alone are insufficient — integration tests are needed:**
- Code that reads from or writes to a database (queries, transactions, migrations)
- Code that calls external APIs or services over HTTP/gRPC
- Code that coordinates multiple modules where the interaction is the risky part
- Code where filesystem, queue, cache, or event-bus behavior matters to correctness
- Code where mocking a dependency would hide the very bug you need to catch

**Signals that e2e tests are needed (in addition to lower-level tests):**
- A critical user-facing workflow (checkout, signup, payment, onboarding)
- A flow that crosses multiple independently deployed services
- A workflow that has broken in production before despite passing lower-level tests
- A deployment smoke test (does the system start and serve basic requests?)

**When you detect these signals, tell the user explicitly** — name the signal, the level it
calls for, and offer to set it up:
> "This service writes to the database and calls an external payment API. Unit tests alone
> won't catch query bugs or API contract mismatches. I'd recommend integration tests with a
> real (or in-memory) database and a faked HTTP boundary for the payment API. Want me to set
> those up?"

For how to write them, read `integration-e2e.md`. E2E suites must be hermetic — see
`hermetic-e2e.md`: self-provisioned infra on ephemeral ports, one env-driven source of truth,
fail-fast health gates, per-spec DB isolation.

**User-visible change?** Passing unit and integration tests do not close it — `functional-verify`
drives the real browser and owns that proof.

---

## What to Test

### Test behavior through public APIs

```
Input → [your code] → Output
  ↑                      ↑
Test this              Assert this
```

**Public API:** exported functions, HTTP endpoints, CLI commands, UI interactions,
message/event handlers.

**Not the API:** private functions, internal state, implementation-specific data structures,
which helpers get called internally.

### Coverage through behavior

When coverage is low, the question is never "what line am I missing?" It is always **"what
business behavior am I not testing?"** Line coverage is a diagnostic, never a target.

### Parameterize input variations

Input variations of ONE behavior belong in ONE table-driven test, not N copy-pasted functions.
Build the case table from equivalence partitions (one representative per class of inputs that
behave the same) plus boundary values (the edges where classes meet — that's where bugs live).

```python
@pytest.mark.parametrize("amount,expected_error", [
    (-1, "must be positive"),     # below boundary
    (0, "must be positive"),      # boundary
    (1, None),                    # smallest valid
    (10_000, None),               # largest valid
    (10_001, "exceeds limit"),    # above boundary
])
def test_S4_validates_payment_amount(amount, expected_error):
    result = validate_payment(make_payment(amount=amount))
    assert result.error == expected_error
```

N near-identical test functions exercising one behavior with different inputs is a defect —
collapse them.

### Test edges, not internals

Focus on: happy paths, edge cases (range limits, empty inputs, maximum sizes), error cases,
business rules.

Do not test: that function A calls function B, internal state transitions, private method
return values, trivial getters/setters, **the wording of log lines and human-readable output**
(below).

### Do not assert on log or message text

A message assertion pins the test to prose: reword for clarity and a green suite turns red,
having caught no bug. It also hides the missing real assertion — a test that checks the success
message often never checks that anything was started.

**Default: assert on state and exit codes. If a message must be involved, assert that the
stream was written to, not what it said.**

```typescript
// ❌ Breaks on any copy edit; proves nothing about the daemon
expect(stdout.join("")).toContain("Started the capture watcher (process 444)")

// ✅ Survives rewording; proves the daemon is actually running
expect(code).toBe(0)
expect(await readPidFile()).toBe(444)

// ✅ When the point is that a failure was surfaced, not its phrasing
expect(code).toBe(1)
expect(stderr.length).toBeGreaterThan(0)
```

**Assert on output text only when the output is the only observable effect** — reporting
commands, formatters, protocol responses, or a warning on a path that changes no state. Assert
on structure and key values (parse the JSON, check the field; match an error code or slug),
never a full sentence.

If asserting on state would require contorted mocking, that is a testability problem — see
"Assess testability" — not a license to assert on prose.

---

## Test Organization

### Name tests by behavior

```
// Bad: describes implementation
"should call validateAmount and return error object"

// Good: describes behavior
"should reject negative payment amounts"
"should apply 15% tax to orders over $100"
```

### No 1:1 mapping between tests and implementation

Tests describe behaviors, not files. If you refactor `payment-validator.ts` into two files, the
behavior hasn't changed, so the tests shouldn't need to change either.

If a test is hard to read, it is testing too much.

---

## Test Data: Factory Functions

Complete defaults, partial overrides, fresh instance per call. Adapts to any language.

```python
def make_user(**overrides):
    defaults = {
        "id": "user-123",
        "name": "Test User",
        "email": "test@example.com",
        "role": "user",
        "is_active": True,
    }
    return User(**{**defaults, **overrides})

def test_deactivated_users_cannot_login():
    user = make_user(is_active=False)
    result = login(user.email, "password")
    assert result.success is False
    assert result.error_code == "ACCOUNT_DEACTIVATED"
```

**Rules:** return complete objects (every required field defaulted) · validate against real
schemas when available — import the production schema, don't redefine it · compose factories
for nested objects · no shared mutable state — fresh instance per call.

---

## Mocking: A Last Resort

Mocks isolate your code from things that are slow, flaky, or outside your control. They are not
a default tool.

**When appropriate:** external HTTP APIs, databases in unit tests, system clock, filesystem in
unit tests, third-party services.

**When it's a code smell:** mocking your own code, mocking "to be safe," mock setup longer than
the test, mocking to avoid understanding a dependency.

**Rules when you do mock:**
1. Understand the real dependency first
2. Mock at the boundary, not deep inside — see below
3. Mock complete structures — partial mocks hide bugs
4. Assert on outcomes, not interactions — with one exception, see "Asserting across a boundary"
5. Prefer fakes over mocks when possible

### What "the boundary" means

A **boundary** is the line where your code stops and something you don't control starts: the
network, the filesystem, the clock, another process, a third-party service.

Find it by asking: **if I replace this, am I replacing something I wrote, or something the
outside world provides?**

```
┌──────────────────────────────────────┐
│  YOUR CODE — mock only to reach a    │
│  boundary you cannot afford          │
│  command → service → helper          │
│                         │            │
├─────────────────────────┼────────────┤ ← the boundary
│  THE OUTSIDE WORLD      ▼            │
│  fetch · fs · spawn · Date.now       │
│  db driver · payment SDK             │
└──────────────────────────────────────┘
```

**Mock below the line.** Above it, a helper inside the module under test is never a valid
target — you would be mocking the thing you are testing. A sibling module you wrote is a last
resort: let it run unless it reaches a boundary you cannot afford.

**The practical test — delete the mock and run it.** If it now fails because of a network call,
a spawned process, a file write, or a wall-clock read, that is a boundary: mock it. If it fails
because of your own logic, you were mocking above the line.

### Asserting across a boundary

Rule 4 has one exception: **what crosses a boundary is a contract**, observed by an external
system, so asserting on it tests a real interface rather than your call graph.

```typescript
// ✅ Contract at a real boundary — the argv and env a child process receives
expect(spawn.mock.calls[0][1]).toEqual([cliEntry, "watch", "--foreground"])
expect(spawn.mock.calls[0][2].env.APP_DAEMON).toBe("1")

// ❌ Coupling — resolveProject is a module you wrote
expect(resolveProject).toHaveBeenCalledWith("/work/widget")
//    the observable outcome is the stored path — assert on that instead
```

**Absence of an effect** is also legitimate, because there is no state to inspect:

```typescript
// ✅ "reports an unpaired CLI without calling the server" — the no-network property IS the behavior
expect(fetch).not.toHaveBeenCalled()
```

Everywhere else, prefer state — see "Fakes that hold state".

### Fakes that hold state

When several mocks represent one system (credentials, a hook, a daemon), give them a shared
mutable object instead of asserting on calls. Interaction assertions become state assertions,
and the test survives refactoring.

```typescript
// One in-memory stand-in for the machine state the command mutates
const world = { token: null, hookInstalled: false, runningPid: null }

beforeEach(() => {
  vi.mocked(readToken).mockImplementation(async () => world.token)
  vi.mocked(installHooks).mockImplementation(() => { world.hookInstalled = true; return 0 })
  vi.mocked(startDaemon).mockImplementation(async () => { world.runningPid = 444; return 444 })
})

test("init installs the hook and starts the daemon", async () => {
  expect(await initCommand()).toBe(0)
  expect(world.hookInstalled).toBe(true)   // ✅ outcome
  expect(world.runningPid).toBe(444)       // ✅ outcome
})                                          // not: expect(installHooks).toHaveBeenCalled()
```

For the full anti-pattern catalog and mock audit checklist, read `anti-patterns.md`.

---

## Detecting Bad Tests

Signs that tests are providing false confidence:

- **Asserting on mock existence** instead of real behavior
- **`.toHaveBeenCalled()` without checking outcomes**
- **Asserting on log or message wording** where state was available instead
- **Assertions that cannot fail** — a substring that also appears in help text, a check on a
  value the test set that nothing under test modifies
- **A test name that promises more than the assertions deliver** — "fails with the reason" that
  only checks an exit code
- **Happy-path-only coverage** — 100% line coverage, 0% branch coverage
- **Tests that break on every refactoring**
- **Mock setup longer than the test itself**

**Mutate it.** Break the production line a test claims to cover, run the test, restore. A test
that stays green under mutation is theater — it protects nothing while reading like coverage.
This is the only reliable check that an assertion is load-bearing; it takes seconds, so do it
for any test you suspect.

---

## React / RTL Specifics

Version-sensitive facts that stale training data gets wrong, plus the query discipline:

- **No manual `act()`** — RTL auto-wraps `render`, `userEvent`, `fireEvent`, `waitFor`, and
  `findBy*`. Manual `act()` is only needed for direct state updates in `renderHook`.
- **No manual `cleanup()`** — automatic after each test since RTL v9. Remove it.
- **No shallow rendering** — it skips child components and hides integration bugs. If you see
  Enzyme, `shallow()`, or `wrapper.state()` in a codebase, flag it.
- **Query priority:** `getByRole` > `getByLabelText` > `getByText` > `getByTestId` (last
  resort — needing it usually means an accessibility gap). Never query by class name or
  internal structure.
- **Custom hooks:** `renderHook(() => useAuth(), { wrapper })` — pass providers via `wrapper`.
- **Mock APIs at the network level (MSW), not the module level** — the component then executes
  its real fetch path; only the response is faked.
- **Error boundaries:** spy on `console.error` and restore it, or React's error logging fails
  the test:

  ```tsx
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<ErrorBoundary fallback={<div>Something went wrong</div>}><Throws /></ErrorBoundary>);
  expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  spy.mockRestore();
  ```

- **Props are a boundary.** A component's callback props are its public API — asserting what
  the component passed to `onSubmit` is a contract assertion ("Asserting across a boundary"),
  not coupling. This does not extend to modules the component imports.

---

## Checklist

- [ ] Each test names a behavior, exercised through the public API
- [ ] Factories provide complete, valid data; no shared mutable state
- [ ] Mocks sit at a boundary; assertions on outcomes (or boundary contracts / absence)
- [ ] No assertions on message wording (unless output is the only observable)
- [ ] Every assertion verified by mutation
- [ ] Edge and error paths covered; input variations parameterized
- [ ] Test level matches where the complexity lives
- [ ] Hard-to-test code flagged for refactoring, not wrapped in mocks
