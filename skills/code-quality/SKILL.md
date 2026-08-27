---
name: code-quality
description: High-quality code patterns with strict types, functional programming, and immutability. Use when writing ANY code in any language. Trigger whenever the user writes, reviews, or refactors code — even if they don't explicitly ask for "quality" or "strict" patterns. This skill applies to TypeScript, Python, and any future languages. Always load this skill for implementation tasks.
---

# Code Quality

Write code that is correct, predictable, and simple.

## What Governs This Code

**This skill never gets skipped.** Its rules are the floor; the project's own standards are the ceiling and win every conflict.

Read these in order, highest priority first. Later sources fill gaps; they never relax a rule an earlier one set:

1. `$ARGUMENTS`, when it is a path to an existing file
2. `.claude/harness/code-quality-reference.md` in the project root
3. Any standards the repo already documents — `CODING_STANDARDS.md`, `CONTRIBUTING.md`, `STYLE_GUIDE.md`, `docs/` equivalents, or the conventions section of `CLAUDE.md`/`AGENTS.md`
4. The language reference for the file you are writing — `references/typescript.md` (strict mode, schema-first boundaries, branded types) or `references/python.md` (strict type checking, Pydantic validation, frozen dataclasses). Read it before writing that language
5. The defaults below, which apply universally

A repo's documented standards may **add** rules or **override** any default here — including naming, formatting, layering, or a house pattern that contradicts a default. Follow them and say which source you followed. What they cannot do is silently remove a rule by not mentioning it: absence is a gap, filled by the next source down.

---

## Strict Types

Never silence the type checker. If you don't know a type, use the language's safe unknown type.

| Language   | Banned                                      | Use instead                        |
|------------|---------------------------------------------|------------------------------------|
| TypeScript | `any`, `as Type`, `@ts-ignore`              | `unknown`, type guards, narrowing  |
| Python     | `Any`, `# type: ignore`, `cast()`           | `object`, `TypeGuard`, `Protocol`  |

Type assertions and ignore directives are a sign that the code's design doesn't fit its types. Fix the design, not the type checker.

---

## Functional Patterns

### Immutability

Never mutate data — return new values.

- Enforce at the type level: `readonly` (TypeScript), `frozen=True` (Python dataclasses)
- Copy-then-modify: spread operators, `dataclasses.replace()`, `dict | updates`

### Pure Functions

Keep impure operations — I/O, mutation, time, randomness — at the boundaries (API handlers, CLI entry points, database adapters). Keep core logic pure: "functional core, imperative shell."

### Composition Over Complexity

Build programs from small, focused functions that compose together. Each function does one thing.

Signs you need to decompose: a body over ~20 lines, more than 2 levels of nesting, or a section that needs a comment to explain it. Read the next section before extracting — an extraction still has to pass the gate there.

### The Cost of Abstraction

Extraction **relocates** reading cost rather than removing it: the call site gets shorter by the lines moved out, and every reader who needs the detail pays one jump. It is worth it when the lines saved exceed that jump.

#### The gate (mandatory)

Extract for one of three reasons. If none applies, the default is **do not extract**.

**1. Reuse** — the same code exists in 2+ places. Either because a block must change together (DRY), or because a short expression is complex enough that every call site re-pays the cost of decoding it.

**2. Organizing a large function** — a long body splits into named steps that each make sense on their own.

**3. Undecodable body (rare)** — a short, single-use body a reader cannot decode on sight: unexplained arithmetic, a magic format or protocol detail, a sequence whose *purpose* isn't visible from the operations.

Reasons 1 and 2 are what should produce most of your extractions. Reason 3 is a genuine exception held to a high bar: not "this could have a name" — nearly anything could — but "a competent reader stops and works out what this achieves." If you find yourself arguing for it, the answer is no.

Repetition alone doesn't justify a function when the repeated thing reads on sight — `rows.length > 0` at five call sites is still five clear lines. Repetition matters when the code is *complex*, or when the copies must stay in sync.

```js
// REASON 1 — GOOD. One line, but negative-modulo is invisible arithmetic and every
// call site would otherwise re-decode it. Complexity + repetition, not repetition alone.
const wrapIndex = (i, len) => ((i % len) + len) % len;

// REASON 1 — GOOD. One definition of a domain rule that must change in one place.
const isOverdue = (invoice, now) => invoice.dueDate < now && invoice.status !== 'PAID';

// REASON 3 — GOOD. Two lines, one call site. The operations don't reveal that this
// means "start of the billing week in the account's timezone".
const billingWeekStart = (date, tz) => {
  const local = utcToZonedTime(date, tz);
  return startOfWeek(subDays(local, BILLING_WEEK_OFFSET_DAYS), { weekStartsOn: 1 });
};

// BAD — these read on sight. A name adds a jump and removes nothing, at 1 call
// site and at 100.
const shouldQueueExport = (count, limit = LINE_ITEM_CSV_LIMIT) => count > limit;
const resolveExportCount = ({ documentIds = [], totalRecords = 0 }) =>
  documentIds.length ? documentIds.length : totalRecords;
const hasItems = (rows) => rows.length > 0;

// Instead — the constant IS the shared knowledge; the expressions inline.
export const LINE_ITEM_CSV_LIMIT = 100;
if (count > LINE_ITEM_CSV_LIMIT) { ... }
const count = documentIds.length || totalRecords;
```

**The substitution test:** replace the call with the body at the call site. If the call site reads *worse*, the name earned its keep. If it reads the same or better, inline it.

**A file full of two-line helpers is the failure this gate exists to prevent.** If applying it leaves you with several short single-use functions, you have used reason 3 as the rule — and the jumps compound:

```js
// BAD — six jumps to read fifteen lines, and no jump teaches you anything.
const handleExport = () => {
  const count = resolveExportCount({ documentIds, totalRecords });
  if (shouldQueueExport(count)) return queueExport();
  if (shouldOwnLoadingState(documentIds)) setLoading(true);
};
```

**Never extract for these reasons:**

- **To create a test hook.** An export that exists so a test can import it serves the test, not the caller. Test the behavior through the code that actually calls it.
- **To satisfy "one thing per function"** when nothing calls it twice and the name restates the body.

### Declarative Data Transformations

Use `map`, `filter`, `reduce` (or list comprehensions) over imperative loops. Loops are acceptable for early termination with no declarative alternative, or where performance is measured and matters.

### Early Returns Over Nesting

Flatten control flow with guard clauses — check invalid conditions and return early, so the main logic stays at the top indentation level.

### Options Objects / Keyword Arguments

When a function takes 3+ parameters, use a named structure (options object in TypeScript, keyword arguments or a dataclass in Python). This eliminates ordering bugs and makes call sites self-documenting.

---

## Comments

Write a comment when one of three things is true:

- **The code is not obvious** — a non-obvious algorithm, a workaround for an upstream bug, a constraint imposed from outside the code (a protocol quirk, a legal requirement).
- **A design decision is invisible in the block** — a trade-off taken, an alternative rejected, an ordering that matters.
- **A future maintainer would otherwise break it** — why this must stay in sync with something else, why the obvious simplification is wrong.

Each is **load-bearing**: delete it and a competent reader stalls. Judge per comment, test files exactly as production code, docblocks exactly as `//`.

**One or two lines.** Say the thing the code can't and stop — the reason, not the mechanism. If the reason needs a paragraph, it belongs in the design doc or the commit message, and the comment is the one line that points there.

```js
// Server returns totals one page behind under concurrent writes; re-reading after
// the final page is the only way to get a consistent count. Upstream issue #4471.
const total = await refetchTotal();
```

If none of the three apply, the fix belongs in the code, not in a comment — rename the thing, give the intermediate value a name, add a type alias.

Three kinds of comment feel natural to write and never apply. Delete them on sight:

- **Restates an adjacent name** — now there are two things to keep in sync.
- **Cites a spec, plan, or ticket** (`REQ-013`, `AC7`, phase numbers) — these belong in test names, where they stay checked.
- **Narrates the work's history** (`// BUG 2 (fixed in review)`) — that is the commit message's job.

**Match the file's style, not its density.** Where a comment is load-bearing and the file documents in JSDoc, write JSDoc. A file thick with docblocks never makes a new one load-bearing.

---

## Error Handling

Represent expected failures as values, not exceptions. Business logic errors (validation failures, not-found, permission denied) are a Result type — a discriminated union `Success(data: T) | Failure(error: E)` — so the type system forces callers to handle both cases.

Reserve exceptions for programmer errors and truly exceptional situations (assertions, invariant violations, resource exhaustion) where recovery isn't expected.

---

## Dependency Injection

Inject dependencies through function parameters, not by importing and instantiating them internally. This keeps the dependency graph explicit and lets you swap implementations without touching business logic.

**The rule**: If a function uses an external service (database, API, cache, file system), that service is a parameter — not something created inside the function.

**Scope it to real boundaries.** A dependency worth injecting is a *substitutable collaborator that crosses a process or I/O boundary* — something with more than one legitimate implementation. Ordinary calls within your own module are not dependencies; passing one in doesn't invert anything, it just moves the call up a level and forces every caller to supply it.

```js
// NOT dependency injection — `fetchRows` is this function's own body, passed in as an argument.
const fetchLineItemExportRows = async ({ knownCount, fetchRows }) => {
  if (!knownCount) return { rows: [], total: 0 };
  return fetchRows();
};
```

Injecting purely to make something mockable is the same mistake in another direction — see the gate in **The Cost of Abstraction**. If a test is the only reason a seam exists, the seam serves the test, not the design.

---

## Schema-First Validation

Validate where external data enters the system (API requests, file reads, environment variables, user input). Define schemas once and derive types from them. Inside the system, trust the type system — don't re-validate what the boundary already checked.

