---
name: testing
description: >
  Behavior-driven testing patterns and test-first methodology. Use this skill whenever writing tests,
  adding test coverage, reviewing test quality, setting up test infrastructure, or when a user mentions
  testing, TDD, test factories, mocking, or test coverage. Also trigger when asked to "add tests" or
  "make this testable" for any language or framework. If the user is working with React components,
  also read references/react-testing.md after this file.
---

## Project-Specific Guidelines

1. If `$ARGUMENTS` is a path to an existing file, read it and prioritize
   its guidelines over the defaults below.
2. Otherwise, check if `.claude/harness/testing-reference.md` exists in the
   project root. If it does, read it and apply its guidelines.
3. If neither exists, use the defaults below.

User-provided guidelines take precedence on conflicts with defaults.


# Testing: Behavior Over Implementation

This skill is language-agnostic. For framework-specific patterns, read the relevant reference file:
- **React**: `references/react-testing.md`
- **Anti-patterns & mock discipline**: `references/anti-patterns.md`
- **Integration & e2e testing**: `references/test-granularity.md`

---

## The Core Idea

Tests exist to answer one question: **"Does this code do the right thing?"**

Not "does it call the right functions," not "does it use the right data structures," not "does it follow a certain code path." Just: does it produce the correct outcome for a given input?

This distinction matters because tests that verify *how* code works break every time you refactor. Tests that verify *what* code does survive refactoring and catch real bugs. The goal is tests that act as a safety net for change, not a cage that prevents it.

---

## Before Writing Any Tests: The Analysis Step

Before writing a single test, perform two assessments on the code under test. Both are mandatory.

### 1. Assess Testability

Read the code. Ask: **Is this code easy to test as-is?**

If no, **stop**. Do not write contorted tests full of mocks and workarounds. Identify the barrier and suggest refactoring first.

| Problem | Why It's Hard to Test | Refactoring Direction |
|---------|----------------------|----------------------|
| Hidden dependencies (constructors create collaborators) | Can't substitute dependencies | Inject via constructor/function parameters |
| Global state or singletons | Tests interfere with each other | Pass state explicitly; dependency injection |
| Large functions doing many things | Too many scenarios to cover | Extract smaller, single-purpose functions |
| Deep inheritance hierarchies | Unclear what behavior belongs where | Favor composition over inheritance |
| Side effects mixed with logic | Can't test logic without triggering side effects | Separate pure logic from I/O |
| Direct calls to external systems | Tests become slow and flaky | Wrap behind an interface/abstraction |
| Tight coupling between modules | Changing one thing breaks everything | Define clear boundaries and interfaces |

**When you encounter untestable code, present the user with specific refactoring suggestions before proceeding.** Explain *why* the current structure is hard to test and *what* the refactored version enables. Let the user decide whether to refactor first or proceed as-is.

### 2. Assess What Test Level Is Needed

After confirming the code is testable, determine the right test level. Scan the code for these signals:

**Signals that unit tests alone are insufficient — integration tests are needed:**
- Code that reads from or writes to a database (queries, transactions, migrations)
- Code that calls external APIs or services over HTTP/gRPC
- Code that coordinates multiple modules where the interaction is the risky part
- Code that reads from or writes to the filesystem in a way that matters to correctness
- Code that uses message queues, caches, or event buses
- Code where mocking a dependency would hide the very bug you need to catch

**Signals that e2e tests are needed (in addition to lower-level tests):**
- A critical user-facing workflow (checkout, signup, payment, onboarding)
- A flow that crosses multiple independently deployed services
- A workflow that has broken in production before despite passing unit/integration tests
- A deployment smoke test (does the system start and serve basic requests?)

**When you detect these signals, tell the user explicitly.** For example:
> "This service writes to the database and calls an external payment API. Unit tests alone won't catch query bugs or API contract mismatches. I'd recommend integration tests with a real (or in-memory) database and a faked HTTP boundary for the payment API. Want me to set those up?"

> "This is the checkout flow — it touches the cart service, payment service, and email service. The individual services should have their own integration tests, but given this is a critical revenue path, a small e2e test for the happy path would add confidence. Want me to add one?"

For the full guide on *how* to write integration and e2e tests, read `references/test-granularity.md`.

### Browser Verification During Development

When the project has a browser automation tool available (Playwright MCP or similar) and the change is user-visible:

1. After implementation passes unit/integration tests, open the running application in the browser
2. Navigate to the affected page
3. Take an accessibility snapshot (preferred over screenshots — more stable, fewer tokens)
4. Verify the feature renders and behaves correctly
5. If something is wrong, fix it before moving on

This is not a formal e2e test — it's a quick sanity check that catches visual/interaction bugs that pass in unit tests. Treat it as part of the GREEN step verification.

### The Test-First Mindset

Write the test before the implementation:

1. **RED**: Write a test that describes the behavior you want. Run it. Watch it fail.
2. **GREEN**: Write the minimum code to make the test pass.
3. **REFACTOR**: Clean up while all tests stay green.

> **Note:** This skill focuses on **test quality** — what makes a good test and how to write one. For the full RED-GREEN-REFACTOR workflow process, load the `tdd` skill.

---

## What to Test

### Test Behavior Through Public APIs

The public API is the contract your code offers to its consumers. Test at that boundary.

```
Input → [your code] → Output
  ↑                      ↑
Test this              Assert this
```

**What counts as a "public API":** exported functions, HTTP endpoints, CLI commands, UI interactions, message/event handlers.

**What does NOT count:** private functions, internal state, implementation-specific data structures, which helpers get called internally.

### Coverage Through Behavior

When coverage is low, the question is never "what line am I missing?" It is always **"what business behavior am I not testing?"**

### Test Boundaries, Not Internals

Focus on:
- **Happy paths**: Normal, expected usage
- **Edge cases**: Boundary values, empty inputs, maximum sizes
- **Error cases**: Invalid input, missing data, failure modes
- **Business rules**: Domain-specific constraints and logic

Do not test:
- That function A calls function B (implementation coupling)
- Internal state transitions (implementation detail)
- Private method return values (not part of the contract)
- Trivial getters/setters (no meaningful behavior)

---

## Test Organization

### Name Tests by Behavior

```
// Bad: describes implementation
"should call validateAmount and return error object"

// Good: describes behavior
"should reject negative payment amounts"
"should apply 15% tax to orders over $100"
```

### No 1:1 Mapping Between Tests and Implementation

Tests describe behaviors, not files. If you refactor `payment-validator.ts` into two files, the behavior hasn't changed, so the tests shouldn't need to change either.

### Structure Tests Clearly (Arrange-Act-Assert)

Each test has three phases:
1. **Arrange**: Set up inputs and conditions
2. **Act**: Execute the behavior under test
3. **Assert**: Verify the outcome

If a test is hard to read, it is testing too much.

---

## Test Data: Factory Functions

Use factory functions to create test data. They solve three problems: fresh state every time, always complete and valid, intent clear from overrides.

### Core Pattern

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
    assert "deactivated" in result.error
```

### Rules for Factories

1. **Return complete objects** — every required field has a sensible default
2. **Validate against real schemas when available** — import the production schema, don't redefine it
3. **Compose factories for nested objects** — `make_order()` calls `make_item()`, `make_customer()`
4. **No shared mutable state** — each call returns a fresh instance

---

## Mocking: A Last Resort

Mocks isolate your code from things that are slow, flaky, or outside your control. They are not a default tool.

**When appropriate:** external HTTP APIs, databases in unit tests, system clock, filesystem in unit tests, third-party services.

**When it's a code smell:** mocking your own code, mocking "to be safe," mock setup longer than the test, mocking to avoid understanding a dependency.

**Rules when you do mock:**
1. Understand the real dependency first
2. Mock at the boundary, not deep inside
3. Mock complete structures — partial mocks hide bugs
4. Never assert on mock behavior — assert on outcomes
5. Prefer fakes over mocks when possible

For the full mock audit checklist and anti-pattern catalog, read `references/anti-patterns.md`.

---

## Detecting Bad Tests

Signs that tests are providing false confidence:

- **Asserting on mock existence** instead of real behavior
- **`.toHaveBeenCalled()` without checking outcomes**
- **Happy-path-only coverage** — 100% line coverage, 0% branch coverage
- **Tests that break on every refactoring**
- **Tests that require scrolling** to understand

For detailed examples and fixes, read `references/anti-patterns.md`.

---

## Making Existing Code Testable

1. **Identify the testability barrier** (see the table above)
2. **Write a characterization test** — captures current behavior as a safety net
3. **Propose the refactoring** to the user with a clear explanation of the benefit
4. **After refactoring, replace the characterization test** with proper behavior tests

---

## Checklist

When writing or reviewing tests, verify:

- [ ] Each test describes a behavior, not an implementation detail
- [ ] Tests use the public API, not internal methods or state
- [ ] Factory functions provide complete, valid test data
- [ ] No shared mutable state between tests
- [ ] Mocks are only used for external dependencies
- [ ] No assertions on mock behavior (only on outcomes)
- [ ] Edge cases and error paths are covered, not just happy paths
- [ ] Tests would survive an internal refactoring of the code under test
- [ ] Test names describe what the system does in plain language
- [ ] Hard-to-test code was flagged for refactoring before wrapping it in mocks
- [ ] Test level matches where the complexity lives — integration/e2e tests used where unit tests are insufficient
