# Test Scenarios — the writing contract

How a scenario is written. *Which level* it runs at and *which slice* proves it are the Test
Matrix's decisions — a scenario lives in the phase file its matrix row names; a flow chaining
independently-built slices lives in plan.md's `## System Verification`, and the slice
completing the journey authors and runs it. Examples use a neutral domain (user auth)
unrelated to the feature being planned.

## Behavior, not implementation

A scenario describes an **observable outcome** for an **actor** (user, API caller, another
service) given a **starting state** and a **trigger**. It stays true when the code is
refactored, because it never names a private function, an internal call order, or an
intermediate data shape.

| Smells like implementation | Reads like behavior |
|---|---|
| "`hash(pw)` returns a 60-char string" | "the stored password is not the plaintext; the right password verifies, a wrong one doesn't" |
| "`buildOptions()` calls `config.filter`" | "a viewer-role editor offers read only — never delete" |
| "the validator invokes `regex.test`" | "a password without a digit shows the rule's error and blocks registration" |
| asserts a private helper's signature | asserts what the actor sees at the boundary |
| couples to call order or module layout | couples only to the requirement |

The test: **if the assertion would have to change when someone refactors internals without
changing what the user experiences, rewrite it.** Assert at the outermost stable boundary
that isolates the behavior — rendered output, the service's public method and its persisted
effect, the HTTP response. Naming a file in the Steps is fine (it says where the behavior
lives); the Expected asserts only what an actor can observe.

## The format — Steps/Expected

```markdown
Scenario S3: A weak password is rejected with the rule's error
  Steps:
    1. Register with a password missing a digit
  Expected:
    - registration is blocked
    - the message names the unmet rule
  (traces to R2, EC1)
```

- **Id** — `S<n>`, globally unique across the plan, assigned in the Test Matrix. `tdd`
  carries it in the test title; `quality-gate` resolves it against the phase file.
- **Steps** — the concrete actions in order: starting state, then trigger. One or two steps
  for a unit scenario; the full journey for a flow.
- **Expected** — bulleted observable outcomes, including the negative half where it matters
  ("edit and delete are **not** shown").
- **`(traces to …)`** — the `R#`/`NF#`/`EC#` ids. A scenario tracing to nothing is dropped,
  or flags a missing requirement.
- Written out in full exactly once, in its home file — never restated elsewhere, never
  replaced by an id-only pointer.

## Deriving the set

Walk each source; each yields one or more scenarios:

- [ ] Every requirement: its happy path **and** its negative/failure half where one exists.
- [ ] Every edge case: empty, absent, duplicate, malformed, boundary value.
- [ ] State transitions beyond create — edit, re-index, delete — and the round-trip: data
      saved then read back arrives in the original shape, on the normal read path.
- [ ] Config- or data-driven behavior: vary the driving data in the test and assert the
      output follows — never assert a constant.
- [ ] Every capability an actor exercises across screens or services: one flow scenario, per
      named variant — a variant is never covered by substituting a peer.

**The enforcement negative.** A gated requirement ("only an admin deletes", "only in draft")
needs its negative at the boundary that can actually **reject the write** — not only the UI
that hides the button. Derive both: offered-only-in-context (UI) and
rejected-when-submitted-directly (the outermost in-scope boundary that gates the write).
Assert the *desired* rejection even when today's code would accept it — a test encodes the
requirement, not the present bug; flag the gap, never invert the assertion. Only when no
in-scope write path could reject it — no server, no service, no validating form with the
gating context — is there no boundary to assert against: record that omission as a one-line
decision in the phase, not a fabricated API test.

**Regression, when shared code is touched.** Every existing behavior flowing through code
this plan modifies gets a scenario asserting it is unchanged — each named variant separately,
even when the source doc names no such requirement (add it and note the gap). Label them
`(regression)`.

## Before writing phase files

Pair every source item — each requirement, edge case, risk, "shall not change" clause, each
named variant — with the scenario id(s) covering it, in a working pass (never a section in
any output file). What a linear read misses, the pairing catches: the third variant, the
enforcement negative, the plain create-then-read.
