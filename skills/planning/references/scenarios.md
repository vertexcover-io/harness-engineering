# Test Scenarios — the writing contract

How a scenario is written. *Which level* it runs at and *which phase* proves it are the Test
Matrix's decisions — a scenario lives in the phase file its matrix row names; a flow provable
only after every phase lands lives in plan.md's `## Acceptance`, and the phase completing the
journey authors and runs it. Examples use a neutral domain (user auth) unrelated to the feature
being planned.

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
effect, the HTTP response. Naming a file in the setup is fine (it says where the behavior
lives); the expectations assert only what an actor can observe.

## The format

The shape scales with the scenario. One whose setup is a single situation states it in a
`Given` clause; one with genuinely staged setup lists the stages. A numbered list of one is
ceremony — it makes a condition look like a procedure.

```markdown
**S3 — A weak password is rejected with the rule's error** · R2, EC1

Given registration is attempted with a password missing a digit:
- registration is blocked
- the message names the unmet rule
```

```markdown
**S9 — A session expires and the next call is rejected as expired** · R4, R5, EC3

1. Register an account and confirm it
2. Sign in and capture the session
3. Advance past the session's expiry and retry the protected call

Expected:
- the first protected call succeeds
- the retry is rejected as expired, not as unauthenticated
```

- **Heading** — `**S<n> — <observable outcome>** · <ids>`. The id is globally unique across the
  plan, assigned in the Test Matrix; `tdd` carries it in the test title and `quality-gate`
  resolves it against the phase file. Trace ids sit on the heading so coverage is scannable
  without reading bodies — a reader checking whether a requirement is covered shouldn't have to
  read twenty scenario bodies to find out. A scenario tracing to nothing is dropped, or flags a
  missing requirement.
- **Setup** — a `Given …:` clause when state and trigger fuse into one situation; a numbered
  list when they genuinely don't. If the clause needs an "and" joining two independent
  conditions, it wants the list — or it's two scenarios.
- **Expectations** — bulleted observable outcomes, including the negative half where it matters
  ("edit and delete are **not** offered"). Labelled `Expected:` only after a numbered list,
  where it separates the two; after a `Given` clause the bullets follow the colon directly.
- **Regression** — `**S12 (regression) — …**`.
- Written out in full exactly once, in its home file — never restated elsewhere, never replaced
  by an id-only pointer, never summarised in the Test Matrix.

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
