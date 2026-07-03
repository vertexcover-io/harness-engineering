# Test Scenarios Reference

How to derive **behavioral, scenario-based tests** for a plan — tests that pin down what
the feature *does* for a user or a caller, not how a particular function is wired. This is the
part of a plan that proves the feature works and that nothing regressed.

## Contents

- [The core rule: test behavior, not implementation](#the-core-rule-test-behavior-not-implementation)
- [What a scenario is](#what-a-scenario-is)
- [How to derive scenarios (the extraction pass)](#how-to-derive-scenarios-the-extraction-pass)
- [Rewriting an implementation test into a behavioral scenario](#rewriting-an-implementation-test-into-a-behavioral-scenario)
- [Regression scenarios (guarding what already worked)](#regression-scenarios-guarding-what-already-worked)
- [Where scenarios live (phase files, not plan.md)](#where-scenarios-live-phase-files-not-planmd)
- [Coverage checklist](#coverage-checklist)

---

## The core rule: test behavior, not implementation

A behavioral test describes an **observable outcome** for an **actor** (an end user, an API
caller, another service) given some **starting state** and a **trigger**. It stays true when the
code is refactored, because it never names a private function, an internal call order, or an
intermediate data shape.

An implementation test asserts *how* the code is built. It breaks the moment you rename a helper
or restructure a module, even though the feature still works — which is exactly why it has low
value. **The plan must produce behavioral scenarios, not implementation tests.**

| Smells like implementation (avoid) | Reads like behavior (prefer) |
|---|---|
| "`hash(pw)` returns a 60-char string" | "A registered account's stored password is not the plaintext; verify() accepts the right password and rejects a wrong one" |
| "`buildOptions()` calls `config.filter`" | "On a viewer-role editor, only read actions are offered — never delete" |
| "the validator invokes `regex.test`" | "Submitting a password without a digit shows the rule's error and blocks registration" |
| asserts a private helper's signature | asserts what the user/caller sees at the boundary |
| couples to call order or module layout | couples only to the requirement |

> The examples throughout this reference use a neutral illustrative domain (user auth: register, log
> in, token refresh, protected routes) chosen to be unrelated to whatever feature you are planning.
> Your plan's scenarios use the target feature's real vocabulary; only these teaching examples stay
> neutral, so the rules never narrow to one feature's shape.

Heuristic: **if the assertion would have to change when someone refactors internals without
changing what the user experiences, it is an implementation test — rewrite it.** Name the actor
and the boundary (UI, API response, index query, rendered output), not the function.

Test through the **outermost stable boundary** that still isolates the behavior: the component's
rendered output and interactions, the service's public method and its persisted/queryable effect,
the HTTP response, a schema's public entry point and whether it accepts/rejects — not a private
inner function. Naming that public boundary in the **Steps** is fine (it says where the behavior
lives); the **Expected** must still assert an *observable outcome* (accepted/rejected,
rendered/absent, returned/not-returned), never an internal call, private helper, or intermediate
shape. It is fine
for a scenario to reference a file so the implementer knows where to look; it is not fine for the
assertion to depend on that file's internals.

---

## What a scenario is

Every scenario has three conceptual parts, and asserts **one behavior** (or, for a flow, one
capability):

- **Starting state + actor** — the context and who acts (existing data, role, configuration).
- **Trigger** — what happens: a user action, an API call, a query, a re-index on edit. A flow has
  an ordered sequence of these.
- **Observable outcome** — what the actor perceives or what the system now exposes. Include the
  *negative* half when it matters ("…and the other options never appear").

These parts are written as **Steps** (starting state + trigger) and **Expected** (observable
outcome) — the concrete format, subsection grouping, and examples are in "Where scenarios live"
below.

Keep the vocabulary of the domain, not the code — say what the user or caller sees at the boundary,
never which component or function produced it.

Every scenario should **trace to a requirement, edge case, or risk** from the source (e.g.
`F4`, `EC3`, `R1`). If a scenario traces to nothing, either the source is missing a requirement
(flag it) or the scenario is testing implementation trivia (drop it).

---

## Two altitudes: atomic scenarios and end-to-end flow scenarios

A behavior can be proven at two altitudes, and a good plan produces **both** — they are not
redundant, they catch different failures and run at different cost:

1. **Atomic scenario** — one trigger, one observable outcome, at the narrowest stable boundary
   that isolates the behavior (a component's rendered output, a service method's persisted effect,
   one HTTP response, one index query). This is the default shape above. Most requirements,
   edge cases, and regressions live here. These map to **unit** and **API** tests.

2. **End-to-end flow scenario** — an ordered, multi-step user journey through the *running
   system*, from an entry point to a user-visible outcome, proving a whole **capability** works
   together. One flow proves **one capability**; it deliberately crosses the boundaries the atomic
   scenarios each isolate, and asserts the user-visible state at each hand-off (after save, after
   reload, on the next screen) — hand-offs are where integration breaks. When a capability has no
   UI (search, a headless endpoint), its flow is an **API flow**: set up data through the service,
   call the API, assert the response.

**You must derive flow scenarios, not only atomic ones.** A plan made purely of atomic scenarios
silently drops the integration story — the exact thing a reviewer means by "does this actually work
end to end?" For every capability a user (or caller) exercises across more than one screen or
service — create-then-view, save-then-search, edit-then-see-updated — write at least one flow in
addition to the atomic scenarios for its parts. Each distinct variant of a capability (per entity,
role, or data case) is its own flow, even when steps overlap; do not merge unrelated capabilities
into one flow, and do not split one capability into many tiny flows. Under vertical slicing a flow
belongs to the slice that delivers its capability, and — because that slice owns every layer the
capability touches — the flow usually runs entirely on that one slice's code (a phase-level `### E2E`,
per the placement rule below); only a flow combining two independently-built capabilities crosses
slice boundaries into plan.md's System E2E.

Rough altitude guide: a single field validating, a component offering the right options, or one
query returning/omitting a record are **atomic**; a create→save→reopen→appears-downstream journey or
an edit→see-updated journey is an **E2E flow**; a save-then-find-via-API is an **API flow**.

Derive the atomic scenarios first (the extraction pass below), then ask per capability: *what is the
shortest user (or caller) journey that proves this whole thing works?* — and write that as a flow.
(For the concrete Steps/Expected shape of every scenario, see "Where scenarios live" below.)

---

## How to derive scenarios (the extraction pass)

Do this pass once per plan, before writing phase files, so scenarios drive the phases rather than
being an afterthought. Walk every source of behavior and turn each into one or more scenarios:

1. **Functional requirements** → the happy-path scenario for each. (F1 → "a user registers with valid
   details and the account is created.")
2. **Each requirement's failure/negative half** → a scenario for the rejected path. (F5 → "a weak
   password is rejected with the rule's error.") Most requirements imply at least one negative.
   **A "gated"/"scoped"/"only-for-X" requirement needs its negative at the *enforcement* boundary,
   not only the UI-offering one.** Derive both "it is offered in the allowed context" (UI) and
   "submitting it in a disallowed context is rejected" (API/service) — the offering scenario alone
   doesn't prove enforcement, since a caller can hit the API directly. Assert the *desired* behavior
   (the disallowed write **is** rejected) even if current code wouldn't reject it: a test encodes the
   requirement, not the present bug — flag it as a gap to close (or an accepted-risk xfail), and
   never invert the assertion to match current behavior. If the design states only the offering side,
   add the enforcement negative anyway and flag the spec gap. When a requirement is gated on **more
   than one axis** (e.g. by context *and* by type, or by role *and* by state), derive the negative
   for **each axis** — covering one axis does not cover the others.
   **A client-side/form validator that gates submit counts as an enforcement boundary.** The
   enforcement negative does not require a *server* boundary — if the feature's own form/schema
   validation runs before submit and can reject the disallowed value (it has the gating context in
   hand, e.g. the role/party/state), assert the rejection *there*. That validation layer is a real,
   in-scope write-blocking boundary; assert the desired rejection against it (flagging it if current
   code wouldn't reject yet). Do not skip the enforcement negative just because there is no server
   check — reach for the outermost in-scope boundary that gates the write, which is often the
   client-side validator.
   **Exception — no enforcement boundary exists at all by design.** Only when *no* in-scope write path
   — server, service, **or** the feature's own form/schema validation — could reject the disallowed
   value (e.g. storage is a generic array, there is no validation step with the gating context, and
   any backend that would enforce it is explicitly out of scope) is there no boundary to assert
   against. Then do **not** fabricate an API-rejection scenario against a boundary this feature
   doesn't have. Instead, state in one line (in the phase where the gate is offered) that the
   enforcement axis is intentionally out of scope and why, so the omission is a recorded decision, not
   a missed case. Only take this exception when the boundary truly does not exist in scope — not
   merely because current code fails to enforce (that is the flag-and-assert case above), and not when
   a form/schema validator *could* gate it (that is the assert case just above).
3. **Edge cases** listed in the source → one scenario each (empty, absent, duplicate, malformed,
   boundary value, normalization).
4. **State transitions** — not just create. Edit, update, re-index, delete, re-run. ("Editing an
   account's email re-validates it and the updated email is what later reads return.")
5. **Cross-boundary round-trips** — when data is transformed and later read back, assert the
   caller sees the original shape, not the intermediate one. ("An account saved with three roles reads
   back with the same three roles, in order, with their flags intact.") **For any create requirement,
   also include the plain create-then-read/view scenario as its own `### API` scenario:** assert the
   persisted data comes back on the normal read/view path. This is distinct from a search query, from
   a single-transform unit round-trip, and from a UI render test — none of those substitutes for "GET
   the record and the data is there." When one record carries data from several sources, the view
   scenario asserts all of them are returned.
6. **Scope / permission / tenancy boundaries** — who can see or do what. ("An admin-only action is
   never offered to a viewer, and is rejected if a viewer submits it directly.")
7. **Config- or data-driven behavior** — assert the behavior *follows the data*, not a hardcoded
   value: change the driving config in the test and assert the observable output changes with no
   code change. This is how you test "config-driven" as a behavior.
8. **Capabilities that span screens or services** → an **end-to-end flow scenario** (and, for
   no-UI capabilities like search, an **API flow scenario**). After deriving the atomic scenarios
   for a capability's parts, add the flow that proves the parts work together — create→save→reopen→
   render, edit→see-updated, save→search. Give each distinct capability (each entity, each role
   variant) its own flow. See "Two altitudes" above for the shape. **Do not stop at atomic
   scenarios** — a plan with no flow scenarios has not proven the feature works end to end.

For each item ask: *what would a user or caller observe that proves this works?* That sentence is
the **Then**. Then supply the **Given** and **When** that produce it. For a capability, also ask:
*what is the shortest journey through the running system that proves the whole thing works?* — that
is the flow scenario.

Scale the count to the surface area — a handful for a small feature, dozens for a multi-repo one.
Do not pad with restated happy paths; do not skip the negative and edge scenarios to save space
(they are where regressions hide).

---

## Rewriting an implementation test into a behavioral scenario

**Before (implementation test — brittle, low value):**

> Test that `deserialize(serialize(roles), roles) === roles`.

This names two private helpers and their composition. Rename or inline them and the test breaks
while the feature is fine.

**After (behavioral scenario — stable, meaningful):**

```
Scenario: An account's roles survive a save-and-read round-trip unchanged
  Given an account saved with [admin, billing] roles (each with its scope flag)
  When the account is persisted and then read back through the normal read path
  Then the returned roles array is identical to the input —
       same entries, same order, same flags
  (traces to R1, NF1)
```

The behavior — "consumers see the array unchanged" — is what R1/NF1 promise. How the round-trip is
implemented (one helper, two helpers, inline) is free to change.

**Before:** "assert `getAvailableActions('viewer')` returns `['read']`."
**After:**

```
Scenario: A viewer is limited to read actions
  Given an editor open for a viewer-role user
  When the action menu is opened
  Then read is offered and edit/delete are absent
  (traces to F4)
```

---

## Regression scenarios (guarding what already worked)

A feature that touches shared code must prove the **old** behavior still holds. Derive regression
scenarios even when the source doc does not name them:

- **Shared code touched?** For every existing behavior that flows through code this plan modifies,
  write a scenario asserting it is unchanged. (Moving an existing role onto a shared permission table →
  "that role's available actions and validation are exactly as before.")
- **Broadened data/config?** Assert the previously-supported cases still behave. (A new role added to
  a shared permission table must not change other roles' available actions.)
- **Changed shared component?** Assert siblings/other callers are unaffected. (A fix to a shared form
  component → "an unrelated form using the same component keeps its values.")

**Cover each named existing variant separately, at each altitude it is exercised — do not collapse
to one representative.** When the source names several peer cases that flow through the touched code
(e.g. multiple countries, document types, or roles), each named variant needs its own scenario at
every altitude it appears at. Do not cover one variant at the unit level and a *different* one at the
flow level and call the set done — a variant is not a stand-in for its peers. Picking one as a
representative silently drops the rest.

Label these **regression** scenarios explicitly and trace them to the non-functional "unchanged"
requirements (e.g. `NF4`) or risks (e.g. `R3`, `R4`). If the source doc has no such requirement but
the plan touches shared code, add the regression scenario anyway and note the gap.

---

## Where scenarios live (the placement rule)

Scenarios live in **one** home file each. `### Unit` and `### API` scenarios always live in the
phase that delivers them. `### E2E` flows are placed by a **containment test**. Under vertical
slicing each phase is itself an end-to-end capability, so **most E2E flows are phase-level** — the
containment test's default answer is "yes, this phase owns it," and plan.md's System E2E section is
the exception holding only the truly cross-slice journeys.

**The E2E placement test — "can one phase run this whole flow by itself?"**

- **A phase-level E2E flow** is an end-to-end journey whose every step exercises code **that one
  vertical slice owns**. Because a slice spans every layer its capability needs (data → service →
  endpoint → validation → response), a flow like "register a new account, then read it back and see
  it exists with no password leaked" runs entirely on *one* slice's code — that slice can write the
  test, run it, and prove it green *as part of finishing the phase*. It lives in **that phase's
  `### E2E` subsection**, and this is the common case. (Every step — validate, persist, read back —
  is the same slice's own code.)
- **A system-level E2E flow** is a journey that only exists once **several slices are assembled**,
  because its steps **cross slice boundaries** — no single phase can write or run it, since at the
  moment that phase finishes the other slice doesn't exist yet. It lives in **`plan.md`'s
  `## System E2E Tests` section**, and nowhere else. (Example: register, *then* log in with those
  credentials, *then* reach a protected page — registration is one slice, login another, protected
  routes a third, so the combined journey is owned by no single phase.)

**The discriminator is containment, not altitude.** Ask of every flow: *does every step run on code
this one slice builds?* Yes → phase `### E2E` (the common case under vertical slicing). No (it needs
another slice assembled) → plan.md System E2E (the exception). The failure this prevents is twofold:
(a) forcing a genuinely cross-slice flow into a phase that can't run it (a hollow, context-starved
test), and (b) — the failure horizontal slicing caused — draining every good end-to-end test into
plan.md and leaving phases with only unit tests, because horizontal layers could never run a flow on
their own. If plan.md's System E2E section is filling with flows each runnable inside one phase, the
phases were sliced horizontally; re-slice vertically and those flows drop back into their phases.

**Each scenario is written out in full exactly once, in its home file.** Never restate a scenario in
a second file, and never replace it with an id-only pointer such as "see S4 in phase 2" — every file
must read top to bottom on its own. Do not add a per-phase scenario list or matrix, and do not add
Unit/API scenarios to plan.md.

**Derive the whole set first, then distribute.** During the Derive Test Scenarios step, list every
scenario across the feature so you can confirm feature-wide coverage (every requirement, edge case,
risk, and regression). That full list is a *working artifact for you* — it does not get written into
any file as a matrix. Then distribute: Unit/API to their phase, each E2E flow by the containment
test above (phase-level E2E to its phase's `### E2E` — the common case; cross-slice E2E to plan.md's
System E2E Tests section). Number scenarios **globally** (`S1, S2, …`) so trace ids stay unique across files.

**In each `phase-N.md`** — a **Test Scenarios** section grouped into `### Unit`, `### API`, and
(when the phase owns a self-contained end-to-end flow) `### E2E` subsections. **Only include the
subsections that this phase actually has** — a phase with no API scenarios simply omits the
`### API` header; do not print empty subsections or
"None for this phase." A phase has **no Done-When section**: the scenarios listed here *are* the
phase's definition of done, so restating them as a checklist is forbidden.

Within a subsection, each scenario is written as **Steps + Expected**, not Given/When/Then:

- **Scenario `<id>`: `<one-line title>`** — the id (globally unique, `S1, S2, …`) and a short title.
- **`Steps:`** — a numbered list of the concrete actions, in order. For a Unit scenario this is
  usually one or two steps (set up input, trigger). For E2E/API it is the full journey.
- **`Expected:`** — a bulleted list of the observable outcomes. Include the negative half where it
  matters ("edit and delete are **not** shown"). Each bullet is something an actor/caller can observe at a
  stable boundary — never an internal call or private shape.
- **`(traces to …)`** — the requirement / edge-case / risk ids.

The Steps/Expected split is the same behavioral contract as Given/When/Then (Steps = Given+When,
Expected = Then) — the rules in this doc about *observable outcomes* and *no implementation detail*
apply unchanged. It just reads like a runnable test case.

```markdown
## Test Scenarios

### Unit

Scenario S2: A viewer-role editor offers read only
  Steps:
    1. Open an action editor for a viewer-role user
    2. Open the "Add action" menu
  Expected:
    - read is offered
    - edit and delete are never offered to a viewer
  (traces to F4)

Scenario S3: A weak password is rejected with the rule's error
  Steps:
    1. Register with a password missing a digit
  Expected:
    - registration is blocked
    - the message names the unmet rule
  (traces to F5, EC3)

Scenario S8 (regression): Existing OAuth login unchanged
  Steps:
    1. Log in through the pre-existing OAuth provider with valid credentials
  Expected:
    - it authenticates and returns a session exactly as before this change
  (traces to NF4, R3)

### API

Scenario S12: accounts are findable by any assigned role
  Steps:
    1. Save one account with the admin role, one with billing, one with support
    2. Call the search API for each role in turn
  Expected:
    - each search returns only the account holding that role
  (traces to F7)

### E2E

Scenario S18 (flow): Registration works end to end — submitted to confirmable
  Steps:
    1. From the running app, open the registration form
    2. Submit with a weak password, then correct it to a strong one
    3. Read the new account back through the normal read path
  Expected:
    - the weak password shows the rule's error and blocks submit; the strong one registers
    - the account exists on read with the registered email and no plaintext password anywhere
  (traces to F1, F4, F5, F6, EC3)
```

S18 is **phase-level** under vertical slicing: the "register" slice owns the validation, the
persistence, *and* the read-back path, so every step — validate, persist, read back — runs on that
one slice's own code. It lives in that phase's `### E2E`. (Under the old horizontal slicing, model
and endpoint were separate phases and this same flow had to be exiled to plan.md because no phase
could run it end to end — that is exactly the over-centralization vertical slicing fixes.)

A flow reaches plan.md's `## System E2E Tests` only when it genuinely **crosses two slices** — no
single phase can run it because it chains independently-built capabilities:

```markdown
## System E2E Tests    (in plan.md — this flow chains the register, login, and protected slices)

Scenario S20 (flow): A user registers, then logs in, then reaches a protected page
  Steps:
    1. Register a new account with valid details; Save
    2. Log in with those same credentials
    3. Navigate to a protected page
  Expected:
    - registration succeeds and no password is shown anywhere
    - login with the just-registered credentials returns a working session
    - the protected page loads while authenticated and is refused when logged out
  (traces to F1, F3, F6)
```

A phase has **no Done-When section** — the scenarios listed in the phase (Unit/API, plus any
phase-level `### E2E`) *are* its definition of done. Do not add a checklist that restates their ids.

Because there is no central matrix, coverage is verified by the derive-first pass and the checklist
below — walk the requirements/edge-cases/risks and confirm each has a scenario in its home file
(Unit/API and phase-level E2E in a phase; cross-slice E2E flows in plan.md).

### Which subsection does a scenario go in?

Group by the **altitude/boundary the scenario asserts at**, which usually maps to the kind of test
that will be written:

- **`### Unit`** — a single component/function/module behavior at the narrowest boundary: dropdown
  options, one field's validation, a transform's round-trip, a renderer's output. Never crosses a
  repo.
- **`### API`** — a behavior at a service's public API: create-then-view a record, a search query,
  a write rejected at the enforcement boundary. Set up data, call the API, assert the response.
- **`### E2E`** — a multi-step user journey through the running system, from a user entry point to
  a user-visible outcome. These are the flow scenarios. Placement follows the containment test above:
  a flow whose every step runs on **one vertical slice's own code** goes in that phase's `### E2E`
  (the common case — a slice spans every layer, so its capability's flow is self-contained); only a
  flow whose steps **cross slice boundaries** (no single phase can run it end to end) goes in
  plan.md's `## System E2E Tests`.

A single capability often contributes to more than one subsection (a role assignment has a Unit
validation scenario, an API search scenario, and appears in an E2E flow) — that is expected, not duplication.
The subsection is chosen per scenario by where it asserts, not per capability.

---

## Coverage checklist

**This is an action, not a reading.** Before writing the phase files, build an explicit **coverage
map** — a list pairing every source item (each functional requirement, edge case, risk, "shall not
change" clause, and each named variant of a capability) with the scenario id(s) that cover it. Walk
the source top to bottom; do not rely on memory of what you "probably covered." Any source item with
no scenario is a gap you must either fill or flag as a deliberate omission with a reason. The map is
your working artifact (it does not go into plan.md), but you must actually produce it — a plan whose
scenarios were written without this pass reliably drops the coverage that does not fall out of a
linear read: the second/third variant of a capability, the enforcement negative, the plain
create-then-view, the edit/re-index transition.

Cross-check the map against every box below:

- [ ] Every functional requirement has at least one happy-path scenario **and** its negative/failure
      scenario where one exists.
- [ ] Every edge case in the source maps to a scenario.
- [ ] Every "shall not change" / non-functional requirement touching shared code has a **regression**
      scenario — including ones the source didn't explicitly name.
- [ ] Every stated risk that is testable has a scenario that would catch it.
- [ ] State transitions (edit/update/re-index/delete) are covered, not only create.
- [ ] Cross-boundary data has a round-trip scenario asserting the caller sees the original shape.
- [ ] Config-/data-driven behavior is tested by varying the data, not by asserting a constant.
- [ ] No scenario names a private function, internal call order, or intermediate shape in its
      assertion — each asserts an observable outcome at a stable boundary.
- [ ] **Every user-facing capability that spans screens or services has an end-to-end flow
      scenario** (ordered multi-step, checkpoints inline), not only atomic scenarios for its parts.
- [ ] **Every no-UI capability (search, headless validation) has an API flow scenario** — set up
      data, call the API, assert the response — phrased as the caller's journey.
- [ ] Each variant of a capability (per entity, per role, per data case) has its own flow, even
      when steps overlap; a variant is never covered by substituting a different one. Every named
      variant appears at each altitude it is exercised.
- [ ] Every scenario carries a trace tag; anything tracing to nothing is dropped or flags a spec gap.
