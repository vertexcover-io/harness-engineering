---
name: code-quality
description: High-quality code patterns with strict types, functional programming, and immutability. Use when writing ANY code in any language. Trigger whenever the user writes, reviews, or refactors code — even if they don't explicitly ask for "quality" or "strict" patterns. This skill applies to TypeScript, Python, and any future languages. Always load this skill for implementation tasks.
---

# Code Quality

Write code that is correct, predictable, and simple. These principles are language-agnostic — they apply everywhere. Language-specific guidance lives in reference files loaded on demand.

## Language References

When working in a specific language, read the corresponding reference for detailed patterns and examples:

- **TypeScript**: Read `references/typescript.md` — strict mode, schema-first boundaries, branded types
- **Python**: Read `references/python.md` — strict type checking, Pydantic validation, frozen dataclasses

Read the relevant reference file before writing code in that language. The principles below apply universally.

---

## Strict Types

Every language has escape hatches that bypass the type system. Do not use them.

**The rule**: If you don't know the type, use the language's safe unknown type (`unknown` in TypeScript, `object` in Python). Never silence the type checker.

| Language   | Banned                                      | Use instead                        |
|------------|---------------------------------------------|------------------------------------|
| TypeScript | `any`, `as Type`, `@ts-ignore`              | `unknown`, type guards, narrowing  |
| Python     | `Any`, `# type: ignore`, `cast()`           | `object`, `TypeGuard`, `Protocol`  |

Type assertions and ignore directives are a sign that the code's design doesn't fit its types. Fix the design, not the type checker.

---

## Functional Patterns

Functional programming produces code that is easier to test, easier to reason about, and harder to break. These patterns work in any language.

### Immutability

Never mutate data. Always return new values.

Mutable code creates hidden coupling — one function changes data that another function depends on, and debugging becomes archaeology. Immutable code is predictable: the value you passed in is the value you still have.

**In practice:**
- Return new objects/collections instead of modifying existing ones
- Use `readonly` (TypeScript) or `frozen=True` (Python dataclasses) to enforce at the type level
- Copy-then-modify: spread operators, `dataclasses.replace()`, `dict | updates`

### Pure Functions

A pure function has no side effects and always returns the same output for the same input. Pure functions are trivially testable, naturally composable, and safe to run in any order.

**What makes a function impure:**
- Mutating arguments or external state
- I/O (network, filesystem, console)
- Depending on non-deterministic values (current time, random numbers)

**Strategy**: Keep impure operations at the boundaries (API handlers, CLI entry points, database adapters). Keep core logic pure. This is sometimes called "functional core, imperative shell."

### Composition Over Complexity

Build programs from small, focused functions that compose together. Each function does one thing.

Signs you need to decompose:
- Function body exceeds ~20 lines
- More than 2 levels of nesting
- You need a comment to explain what a section does

Extract a well-named function instead of writing a comment.

### Declarative Data Transformations

Use `map`, `filter`, `reduce` (or language equivalents like list comprehensions) over imperative loops. Declarative code expresses *what* you want, not *how* to compute it.

Imperative loops are acceptable when:
- Early termination is essential and no declarative alternative exists
- Performance is measured and matters (profile first)

### Early Returns Over Nesting

Flatten control flow with guard clauses. Check for invalid conditions and return early, keeping the main logic at the top indentation level.

```
# Pseudocode
if not valid_input: return error
if not authorized: return forbidden
if not found: return not_found
# main logic here, flat and clear
```

### Options Objects / Keyword Arguments

When a function takes 3+ parameters, use a named structure (options object in TypeScript, keyword arguments or a dataclass in Python). This eliminates ordering bugs and makes call sites self-documenting.

---

## Self-Documenting Code

Code should be clear through naming and structure, not through comments.

**Instead of comments:**
- Extract functions with descriptive names
- Use meaningful variable names that convey intent
- Break complex expressions into named intermediate values
- Use type aliases for domain concepts

**Comments are acceptable for:**
- Public API documentation (JSDoc, docstrings) when generating docs
- Explaining *why* something unintuitive is necessary (not *what* it does)
- Regulatory or legal requirements

If you feel the need to write a comment explaining what code does, that's a signal to refactor — rename, extract, simplify.

---

## Error Handling

Prefer explicit error types over exceptions for expected failure cases. Exceptions are for truly exceptional situations (programming errors, resource exhaustion). Business logic errors (validation failures, not-found, permission denied) should be represented as values.

**Pattern**: Result types — a discriminated union of success and failure:

```
Result<T, E> = Success(data: T) | Failure(error: E)
```

This forces callers to handle both cases. The type system prevents forgetting to check for errors.

Use exceptions for programmer errors (assertions, invariant violations) where recovery isn't expected.

---

## Dependency Injection

Inject dependencies through function parameters, not by importing and instantiating them internally. This makes code testable (inject mocks), flexible (swap implementations), and honest about its dependencies.

**The rule**: If a function uses an external service (database, API, cache, file system), that service is a parameter — not something created inside the function.

---

## Schema-First Validation

Validate data at trust boundaries — where external data enters your system (API requests, file reads, environment variables, user input). Define schemas once and derive types from them.

Inside the system, between your own functions, trust the type system. Don't re-validate data that was already validated at the boundary.

---

## Summary Checklist

Before considering code complete, verify:

- [ ] No type escape hatches (no `any`/`Any`, no type assertions, no ignore directives)
- [ ] All data structures are immutable (readonly properties, frozen dataclasses)
- [ ] Core logic is pure (side effects at boundaries only)
- [ ] Functions are small and compose well (max ~20 lines, max 2 nesting levels)
- [ ] Declarative transformations over imperative loops
- [ ] Early returns instead of nested conditionals
- [ ] Named parameters for functions with 3+ arguments
- [ ] No comments explaining *what* — code is self-documenting
- [ ] Explicit error types for expected failures (Result pattern)
- [ ] Dependencies injected, not created internally
- [ ] Schemas at trust boundaries, types internally
- [ ] Language-specific checklist from the reference file also passes
