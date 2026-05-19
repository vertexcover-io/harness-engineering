---
name: refactor
description: >
  Refactoring assessment and patterns. Use after tests pass (GREEN phase) to assess improvement
  opportunities, or when the user explicitly asks to refactor code. Guides what to look for,
  how to prioritize, and which techniques to apply. Trigger this skill whenever refactoring is
  mentioned, when assessing code quality after a GREEN phase, or when the user asks to clean up
  or improve existing code structure.
---

# Refactoring

Refactoring is changing internal structure without changing external behavior. It operates
in two modes depending on how it's invoked.

## Invocation Modes

### Post-GREEN (TDD Cycle)
Called automatically after tests pass as the REFACTOR step of RED-GREEN-REFACTOR.

**Scope**: Only the code just written or changed in the current GREEN step — both
production code *and* test code. Do not scan the entire codebase.

### Explicit Request
Called when the user asks to refactor something directly (e.g., "refactor this module",
"clean up the auth code").

**Scope**: Ask the user what to focus on. If they don't specify, offer options:
- A specific file, folder, or module they name
- The files changed in the last commit (`git diff HEAD~1 --name-only`)
- A specific function or class they point to

Never start refactoring "everything." Refactoring without a defined scope leads to
sprawling changes that are hard to review and risky to revert.

---

## Companion Skills

Refactoring doesn't happen in isolation. During assessment, also apply patterns from:

- **`code-quality` skill** — Check scoped code against its patterns: strict types (no
  `any`/`Any`), immutability (`readonly`/`frozen=True`), pure functions, Result types for
  error handling, schema-first validation at trust boundaries, dependency injection. If
  working in a specific language, consult its reference file (`references/typescript.md`
  or `references/python.md`) for language-specific quality patterns.

- **`testing` skill** — Assess test code alongside production code. Check for: tests
  asserting on mock behavior instead of outcomes, missing factory functions, test names
  that describe implementation instead of behavior, tests that would break on refactoring.
  Test code deserves the same quality standards as production code.

These skills are not loaded automatically — reference their patterns during your assessment
and load them if you need the full catalog for a specific concern.

---

## Workflow

1. **Determine scope** — what code is being assessed (see invocation modes above)
2. **COMMIT** (if not already committed): Save working code as safety net
3. **ASSESS**: Scan the scoped code using the dimensions below
4. **DECIDE**: Classify findings by priority — skip if nothing warrants action
5. **REFACTOR**: One small structural change at a time, tests green after each
6. **COMMIT**: Save refactored code separately from the feature commit

Committing before refactoring is the critical safety net. Without it, a bad refactoring
step can bury working code under broken changes with no clean rollback point.

---

## What to Look For

Scan the scoped code across these eight dimensions. This systematic sweep prevents tunnel
vision — developers tend to notice naming issues but miss structural problems, or catch
duplication but overlook consistency violations across modules.

### 1. Naming & Language Conventions

Names should reveal intent *and* follow the language's established conventions. Convention
violations make code feel foreign to developers who work in that language daily, which
slows comprehension and introduces inconsistency.

**Intent:**
- Do names reveal what the code does? (`processData` → `calculateMonthlyRevenue`)
- Are abbreviations ambiguous? (`ctx`, `mgr`, `tmp`)
- Do boolean names read as questions? (`isValid`, `hasPermission`, not `valid`, `flag`)

**Python conventions:**
- Functions/variables: `snake_case` (`get_user_data`, `total_amount`)
- Classes: `PascalCase` (`UserService`, `OrderProcessor`)
- Constants: `UPPER_SNAKE_CASE` (`MAX_RETRIES`, `DEFAULT_TIMEOUT`)
- Modules/files: `snake_case` (`user_service.py`)
- Private: leading underscore (`_internal_helper`)

**TypeScript/JavaScript conventions:**
- Functions/variables: `camelCase` (`getUserData`, `totalAmount`)
- Types/interfaces/classes/components: `PascalCase` (`UserService`, `OrderProps`)
- Constants: `UPPER_SNAKE_CASE` (`MAX_RETRIES`) or `camelCase` for non-config values
- Files: `kebab-case` (`user-service.ts`) or `PascalCase` for components (`UserProfile.tsx`)
- Enums: `PascalCase` members (`Status.Active`)

When code mixes conventions (e.g., `camelCase` variables in Python, `snake_case` in TypeScript),
flag it — this typically means code was ported from another language or written by someone
unfamiliar with the ecosystem.

### 2. Structural Simplicity
- Nesting depth >3 levels — flatten with guard clauses or early returns
- Functions >30 lines — likely doing multiple things
- Parameter lists >3 — consider an options object / keyword arguments
- God functions/classes doing too much — split by responsibility

### 3. Knowledge Duplication (DRY)
DRY means knowledge, not code. Two blocks of code can look identical but represent
different business concepts that will evolve independently — leave those separate.

**Abstract when:**
- Same business concept appears in multiple places
- Changes to one would require changing the other
- The shared meaning is obvious without explanation

**Keep separate when:**
- Similar structure but different domain meaning
- Would evolve independently as requirements change
- Coupling would create confusion about which concept owns the logic

### 4. Abstraction Opportunities
- Repeated patterns across 3+ call sites — extract a function
- Complex expressions — extract to a named variable or function
- Conditional blocks doing the same shape of work — extract the common structure

### 5. Immutability & Purity
- Data mutations where a new value could be returned instead
- Side effects mixed into computation logic — separate pure calculation from I/O
- Shared mutable state — replace with immutable data flow
- Missing `readonly` (TypeScript) or `frozen=True` (Python dataclass) on data structures

### 6. Functional Patterns
- Imperative loops → `map`, `filter`, `reduce` / list comprehensions
- Nested if/else → early returns, guard clauses, or composition
- Mutable accumulators → functional pipelines

### 7. Cross-Module Consistency

When the scope includes multiple modules that serve the same role (e.g., API connectors,
tools in an agent, service adapters, middleware), check that they follow the same patterns.
Inconsistency across peer modules creates confusion about which pattern is "correct" and
makes the codebase harder to extend.

**Check for:**
- **Interface shape**: Do all modules of the same kind expose the same method signatures
  or function shapes? (e.g., all tools have a `run()` method, all connectors return the
  same result type)
- **Error handling**: Is error handling consistent? (e.g., all return Result types, or all
  raise the same exception hierarchy — not a mix)
- **Return types**: Do peer modules return the same shape of data? (e.g., all return
  `dict` vs some return `str` and others return `dict`)
- **Class vs function**: Are peer modules all class-based or all function-based — not a
  mix of both?
- **Configuration pattern**: Do they all accept config the same way? (constructor injection,
  kwargs, global config — pick one)
- **Async consistency**: If some are async, all peers should be async

When you find inconsistency, recommend converging on whichever pattern is already dominant
or best fits the project's conventions. Define a `Protocol` (Python) or `type`/`interface`
(TypeScript) that all peer modules satisfy.

### 8. Test Code Quality

Test code is production code for your test suite — it deserves the same refactoring
attention. When test files are in scope (post-GREEN: the tests you just wrote; explicit:
the tests for the module being refactored):

- **Test names**: Do they describe behavior ("rejects expired tokens") or implementation
  ("calls validateToken")?
- **Assertion targets**: Are tests asserting on outcomes or on mock calls? (`.toHaveBeenCalled()`
  without checking what the system *produced* is a red flag)
- **Test data**: Are factory functions used, or is data duplicated/hardcoded across tests?
- **Mock discipline**: Are mocks only at external boundaries, or is internal code mocked?
- **Test structure**: Does each test have clear Arrange-Act-Assert phases?

For the full anti-pattern catalog, load the `testing` skill.

---

## Priority Classification

After scanning, classify each finding. The threshold for action depends on context — a
quick bug fix warrants less refactoring than a new feature you'll build on top of.

| Priority | Action | Recognize By |
|----------|--------|-------------|
| **Critical** | Fix now | Mutations of shared state, semantic duplication (same knowledge in 2+ places), nesting >3 levels, broken immutability contracts, security issues (SQL injection, unsanitized input) |
| **High** | This session | Magic numbers/strings repeated, convention violations (wrong case style), inconsistent peer modules, unclear names, functions >30 lines, >3 parameters, tests asserting on mocks instead of outcomes |
| **Nice** | Later | Minor naming tweaks, single-use helpers that could be extracted, slight reorganization |
| **Skip** | Don't touch | Already clean code, structural similarity without semantic relationship, "improvements" with no concrete benefit |

**Decision factors when priority is ambiguous:**
- How often is this code read/changed? (Hot paths deserve more polish)
- Does this block the next piece of work? (Refactor if it makes the next RED easier)
- Is test coverage sufficient to refactor safely? (No tests → write tests first, not refactor)

---

## Code Smells Quick Reference

These are the most common signals that code wants refactoring. Recognizing the smell
points you toward the right technique.

| Smell | What It Looks Like | Technique |
|-------|-------------------|-----------|
| **Long Function** | >30 lines, multiple responsibilities | Extract Function |
| **Deep Nesting** | >3 levels of if/for/while | Guard Clauses, Early Returns |
| **Magic Values** | Hardcoded `50`, `"admin"`, `5.99` | Extract Named Constant |
| **Duplicated Knowledge** | Same business rule in 2+ places | Extract Shared Function |
| **Complex Expression** | Hard-to-read boolean or arithmetic | Extract Variable with Intent-Revealing Name |
| **Long Parameter List** | >3 params | Options Object / Keyword Args |
| **Feature Envy** | Function uses another module's data more than its own | Move Function |
| **Mutable Accumulator** | `let result = []; for (...) result.push(...)` | `map`/`filter`/`reduce` / comprehension |
| **God Class/Function** | Does everything, knows everything | Split by Responsibility |
| **Shotgun Surgery** | One change requires edits in many files | Consolidate Related Logic |
| **Dead Code** | Unreachable, commented-out, or unused | Delete It |
| **Primitive Obsession** | Using strings/numbers where a type would be clearer | Introduce Type / Value Object |
| **Switch on Type** | `if type === 'A' ... else if type === 'B'` | Dispatch Table, Strategy Pattern, or Polymorphism |
| **Nested Conditionals** | if → if → if → else → else | Flatten with composition or pattern matching |
| **Convention Violation** | `camelCase` in Python, `snake_case` in TypeScript | Rename to match language conventions |
| **Inconsistent Peers** | Tools/connectors/adapters with different shapes | Define shared Protocol/interface, converge |

---

## Refactoring Techniques

These are the concrete moves. Each one is a single, testable step — apply one, run tests,
verify green, then consider the next.

### Extract Function
Pull a block of code into a named function. The name replaces the need for a comment
explaining what the block does.

**When:** A section of a function does one identifiable thing. You'd want to comment what
it does — instead, make it a function whose name *is* the comment.

### Extract Variable
Give a name to a complex expression so the code reads like prose.

**When:** A boolean condition, arithmetic expression, or chain is hard to parse at a
glance. The variable name communicates intent.

### Extract Named Constant
Replace magic values with named constants that explain the business meaning.

**When:** A literal value appears in code and its meaning isn't immediately obvious from
context. `FREE_SHIPPING_THRESHOLD = 50` is self-documenting; `50` is not.

### Guard Clauses / Early Returns
Replace nested if/else with early exits for edge cases, leaving the main logic at the
top level of indentation.

**When:** A function has a deeply nested "happy path" wrapped in validation checks.
Invert the conditions, return early, and the happy path reads linearly.

### Replace Loop with Functional Pipeline
Convert imperative `for` loops with mutable accumulators into `map`/`filter`/`reduce`
chains (or list comprehensions in Python).

**When:** A loop transforms, filters, or accumulates data. The functional version declares
*what* happens to the data rather than *how* to iterate.

### Separate Pure from Impure
Extract pure computation into its own function, keeping I/O and side effects at the
boundary.

**When:** A function mixes calculation with database calls, API requests, or file I/O.
Splitting makes the calculation testable without mocking.

### Replace Conditional with Dispatch
Replace chains of `if/else if` or `switch` on a type/status with a lookup table or
strategy map.

**When:** You're branching on a value to select behavior, and each branch has similar
structure. A dispatch table is easier to extend and read.

### Introduce Parameter Object
Group related parameters into a single object/dataclass.

**When:** >3 parameters travel together, or the same group of params appears in multiple
function signatures.

### Move Function
Relocate a function to the module where its data lives.

**When:** A function reaches into another module's internals more than its own. Moving it
reduces coupling.

### Split by Responsibility
Break a large class/module into focused pieces, each owning one concept.

**When:** A class has groups of methods that don't interact with each other, or a module
has sections separated by comment headers.

### Inline
Remove an abstraction that isn't pulling its weight — inline the function, variable, or
constant back into its call site.

**When:** A helper exists for a single call site and the name doesn't add clarity beyond
what the inlined code says. Not everything needs to be extracted — three similar lines
are better than a premature abstraction.

### Define Shared Interface
Create a Protocol (Python) or type/interface (TypeScript) that peer modules must satisfy,
then align existing modules to match.

**When:** Multiple modules serve the same role (tools, connectors, adapters) but have
diverged in their public shape. The shared interface makes the contract explicit and
catches drift at the type-checker level.

---

## Execution Rhythm

Refactoring is a sequence of tiny, verified steps — not one large restructuring. Each
step should take seconds to minutes, not hours.

```
[Pick one smell] → [Apply one technique] → [Run tests] → [Green? Commit] → [Next smell]
                                                    ↓
                                              [Red? Undo and take smaller step]
```

**Rules during refactoring:**
- Tests stay green after every step — if a test breaks, undo immediately
- No new behavior — adding behavior means you're in RED phase, not REFACTOR
- No new tests — that's the next RED (exception: if you discover missing coverage during
  refactoring, stop refactoring, write the test RED→GREEN, then resume refactoring)
- One concept per step — rename OR extract OR move, not all three at once

---

## Speculative Code is a TDD Violation

Every line of production code must have a test that demanded its existence. Code written
"just in case" or "for future flexibility" violates this principle and creates maintenance
burden with no proven value.

**Delete:**
- "Just in case" error handling for scenarios that can't happen
- Features not yet needed
- Unused parameters, branches, or configuration options
- Commented-out code ("we might need this later")

If it's needed later, a failing test will demand it then.

---

## When NOT to Refactor

- **No test coverage** → write tests first, then refactor with a safety net
- **Would change behavior** → that's a feature or bug fix, not refactoring
- **Code is "good enough"** → diminishing returns; move to the next RED
- **Premature optimization** → profile first, optimize only proven bottlenecks
- **Different concept, similar structure** → structural similarity without semantic
  relationship is not duplication
- **Third-party / generated code** → wrap it, don't modify it

---

## Assessment Output Format

When scanning code, produce a structured assessment so findings are actionable and
reviewable:

```
## Refactoring Assessment

### Scope
- path/to/module.py (lines 12-45, `get_user_data` function)
- tests/test_module.py (lines 8-30, related tests)

### Findings

**Production Code:**
1. [Critical] `GetUserData` — PascalCase function name in Python → rename to `get_user_data`
2. [Critical] f-string SQL query — injection risk → use parameterized query
3. [High] Nested if/else 3 levels deep → flatten with guard clauses
4. [High] Mutable `result` dict built incrementally → return dict literal

**Test Code:**
5. [High] Tests assert on `mock_db.query.called` — should assert on return value instead
6. [Nice] Test data hardcoded inline → extract factory function

**Cross-Module:**
7. [High] `tools/search_tool.py` is class-based, `tools/calculator.py` is function-based
   → converge on one pattern, define `Tool` Protocol

### Recommended Actions
1. Rename to snake_case (low risk, broad impact on imports)
2. Fix SQL injection (critical security)
3. Flatten conditionals with guard clauses
4. Define `Tool` Protocol for consistent tool interface

### Decision
Proceed with #1-3 as critical/high. #4 is high but affects multiple files — confirm scope with user.
```

---

## Commit Messages

```
refactor: extract shipping calculation from order processing
refactor: replace magic values with named constants
refactor: flatten nested validation with guard clauses
refactor: rename camelCase functions to snake_case (Python convention)
refactor: define Tool protocol and align tool implementations
```

Keep refactoring commits separate from feature commits. This makes git history navigable
and allows reverting a refactoring without losing the feature.

---

## Checklist

Before marking refactoring complete:

- [ ] Committed working code BEFORE refactoring (safety net exists)
- [ ] All tests pass without modification
- [ ] No new public APIs added
- [ ] No new behavior added
- [ ] Code is more readable than before
- [ ] No speculative code introduced
- [ ] Committed separately from feature work
- [ ] Each refactoring step was individually verified
- [ ] Naming follows language conventions (snake_case/camelCase as appropriate)
- [ ] Peer modules are consistent in interface shape and patterns
- [ ] Test code assessed alongside production code
- [ ] Code-quality patterns checked (strict types, immutability, purity)
