# Testing Anti-Patterns

**Read this when** writing or reviewing tests that involve mocks, or when tests feel brittle.

**Mocks are tools to isolate, not things to test.** If you are asserting that a mock was called
or that a mock element exists, you have stopped testing your code and started testing your test
setup.

---

## 1. Testing Mock Behavior

```typescript
// ❌ Asserts the mock rendered — mutate the real sidebar and this stays green
test('renders sidebar', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});

// ✅ Asserts what the user sees
test('renders sidebar navigation', () => {
  render(<Page />);
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});
```

**Two narrow exceptions** — both require the mock to sit at a real boundary (network, process,
filesystem, clock):

1. **A contract crossing that boundary.** The argv and env handed to a spawned process, or the
   body of an HTTP request, are observed by an external system. Asserting on them tests a real
   interface, not your call graph.
2. **Absence of an effect.** "Reports an unpaired CLI without calling the server" has no state
   to inspect — `expect(fetch).not.toHaveBeenCalled()` is the only way to express it.

Neither exception covers mocks of your own modules. `expect(myHelper).toHaveBeenCalledWith(x)`
is coupling — assert on what the helper caused instead. See `What "the boundary" means` in
testing.md.

**Gate question:** "Am I testing real behavior or just mock existence?"

---

## 2. Test-Only Methods in Production Code

```typescript
// ❌ destroy() exists only for test cleanup
class Session {
  async destroy() {
    await this._workspaceManager?.destroyWorkspace(this.id);
  }
}

// ✅ cleanup lives in test utilities
// test-utils/session-helpers.ts
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) await workspaceManager.destroyWorkspace(workspace.id);
}
```

**Gate question:** "Is this method only used by tests? Then it belongs in test utilities, not
production code."

---

## 3. Mocking Without Understanding

Before mocking anything, answer: what side effects does the real implementation have, and does
this test depend on any of them? A mock that swallows a side effect (a write, a state change)
breaks the behaviors that read it.

**When a test fails right after you added a mock, suspect the mock before the code — and never
fix it by weakening the assertion.** Restore the side effect with a state-holding fake (see
"Fakes that hold state" in testing.md), or mock one level lower so the effect survives.

Red flags: "I'll mock this to be safe." "This might be slow, better mock it."

---

## 4. Incomplete Mocks

```typescript
// ❌ Missing the metadata that downstream code reads — its failure surfaces in production, not here
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
};

// ✅ Mirrors the real response completely
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
};
```

**Gate question:** "Does this mock include every field the real response contains?" Check the
real API response or schema — don't guess.

---

## 5. Asserting on Message Wording

```typescript
// ❌ Pins the test to prose, and hides that nothing checks the project was actually enabled
const code = await enableCommand({ cwd: "/work/widget" })
expect(code).toBe(0)
expect(stdout.join("")).toContain('Capture enabled for "acme-widget"')

// ✅ Asserts the state the command changed
expect(code).toBe(0)
expect(await getProject("acme-widget")).toMatchObject({ enabled: true })
```

Keep a message assertion only when the output is the only observable effect.

**Gate question:** "If someone rewrote this sentence, should my test fail?" If no, assert on
state.

---

## 6. Assertions That Cannot Fail

```typescript
// ❌ Also matches "...and watcher status" in a description — passes whether or not
//    the status command is registered
const out = execFileSync("mycli", ["--help"], { encoding: "utf8" })
expect(out).toContain("status")

// ✅ Anchored to structure
const listed = out.slice(out.indexOf("Commands:")).split("\n")
  .map((line) => line.trim().split(/[\s[]/)[0]).filter(Boolean)
expect(listed).toEqual(expect.arrayContaining(["status", "watch"]))
```

Then mutate it: hide the command, run the test, watch it fail, restore.

---

## 7. Tautological Assertions

```typescript
// ❌ Expected value is recomputed the way the code computes it — passes by construction
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// ✅ Expected value is an independent, known literal
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```

Expected values must come from an independent source of truth — a known-good literal, a worked
example, the spec. Never derive them the way the implementation does.

---

## 8. Writing Tests After Implementation

Tests written after the fact mirror the implementation rather than the intended behavior,
cementing bugs instead of catching them. Write the test first, and mutate anything already
written — a test that has never failed might not be testing what you think. The `tdd` skill
owns the workflow.

---

## 9. Over-Complex Mock Setup

**Warning signs:** mock setup longer than the test itself · 5+ mocks for one function ·
`.mockReturnValueOnce()` chains for sequencing · removing a mock breaks the test in unexpected
ways.

**The fix:** This is a testability problem, not a testing problem — the setup complexity
reflects too many dependencies in the production code. Suggest refactoring: extract pure logic
from side-effectful code, reduce direct dependencies, or move up to an integration test (fewer
mocks, more real code).

---

## Prevention: Design for Mockability

At the boundaries you *will* mock, shape the interface so mocking stays trivial:

- **Inject the dependency** — pass the client in; never construct it inside the function under
  test.
- **SDK-style interfaces over generic fetchers** — one named function per external operation:

```typescript
// ✅ Each function independently mockable, one response shape each
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// ❌ Mocking requires conditional logic on endpoint inside the mock
const api = { fetch: (endpoint, options) => fetch(endpoint, options) };
```

---

## Red Flags Checklist

- [ ] Assertion checks for `*-mock` test IDs
- [ ] Methods only called in test files exist in production code
- [ ] A mocked module is one you wrote, not an external boundary
- [ ] Mock setup is more than a third of the test
- [ ] Can't explain why a specific mock is needed
- [ ] `.toHaveBeenCalled()` without checking outcomes
- [ ] Assertion matches a sentence a copy edit would break
- [ ] Expected value computed the same way the code computes it
- [ ] Assertion has never been observed to fail
- [ ] Test name claims more than the assertions check
- [ ] Several near-identical test functions varying only in input values
