# Visual Verification

**Read this when:** `agent-browser` has completed a scenario and its staged frames have passed
their assertions, before those frames move into `verification/screenshots/`. You are mid-walk
with the browser session still open.

**This pass drives nothing, and it runs on one scenario at a time.** That scenario is a desktop walk or a phone
replay; its frames are shot and the session is still open, so where a frame cannot answer a question you ask the
open page — one `eval`, no walk. **Do not re-walk, do not add a viewport, and do not invent a tablet width.** The
replay is already a real device — `set device "iPhone 14"`, not a narrowed window, for the reason
`driving-the-browser.md` gives: an app that branches on user-agent serves its desktop layout to a resized viewport
and photographs a mobile pass that never happened — and it is the only second width there is.

**The one re-shoot.** `driving-the-browser.md`'s *frame that proves it* resizes the viewport freely to fit the
evidence, and a frame shot at 1600 wide cannot be read against a mockup drawn at 1440 without every layout question
failing for nobody's fault. Where that is the case, re-shoot that one screen in the session already open — one
`set viewport`, one `screenshot`, not a walk — and say in `matched` that the comparison ran at a width the scenario
did not drive at.

**It is one pass, not two.** You look at each frame once and ask every question below of it. Some questions have
an answer only where the plan supplies a design; the rest are asked of every screen, drawn or not. Running them
as two sweeps means reading the same image twice and finding the second-pass defects with the first pass's
conclusions already in your head.

It produces the scenario's `visualMatch` (shape in `writing-the-report.md`) and, for anything a user would be
wrong-footed by, a bug that routes through Step 4.

**In here:**

- The baseline, and what it is authoritative about
- The three grades
- The pass — every question, in order
- What it produces

## The baseline, and what it is authoritative about

**Open every staged screenshot first and confirm that it shows the state the scenario intended
to capture.** When the assert and screenshot disagree, wait once and re-shoot. Repeat the browser
action only if the application has left that state. Resolve the disagreement before choosing a
design reference or promoting the frame.

Read the complete `## Design References` section from `plan.md`. For each scenario, select the
image that represents the same screen, state and viewport. Use the image and the row's description
to select it. Do not use the description as a substitute for the image.

**Open the baseline image and staged frame, then compare them.** When several references show the
same screen, choose the one with the same state and viewport. Compare desktop with desktop, phone
with phone, and each state with its matching state.

Compare the visible design: components, element order, layout, spacing, size, typography, colour,
borders, radii, icons and states. Ignore differences in text content alone.

**Where no image defines the screen, the *(design)* questions do not run.** Write
`visualMatch: { baseline: null, fidelity: null }`, ask the rest, and move on — the scenario can pass with no
design behind it. **Do not build a baseline out of anything that is not an image**: not the PRD's prose, not the
plan's acceptance criteria, not a ticket's description. A paragraph fixes no placement, no order and no colour,
so a "match" graded against one is your taste with a number written beside it — and that number reaches the
report looking exactly like a measured one.

**A phone replay has a baseline only where one was drawn at phone width.** The mockup that defines a screen is
almost always a desktop drawing, and a phone layout is *supposed* to differ from it. So a replay runs the *(design)*
questions only where `## Design References` names an image drawn for the phone; otherwise its `baseline` is `null`
and only the *(always)* questions run.

## The three grades

- **BLOCKER** — any visual property differs from the corresponding baseline. The scenario is a
  `FAILURE`, and the functional-verification verdict is `FAIL`.
- **HIGH** — the screen is degraded on its own terms, but no design reference defines the
  affected property.
- **Not a finding** — the only difference is text content, or no image defines the screen.

## The pass — every question, in order

Ask all of these of each frame, in this order, so two runs of the same screen read the same way.

**1. Elements and reading order**
- *(design)* Every element the baseline shows is present, at the same point in the reading order. Missing, or
  moved to a different point → **BLOCKER**.
- *(always)* No region sits empty that should hold something, and nothing is rendered twice.

**2. Component identity**
- *(design)* The same kind of control does each job — a dropdown where a segmented control was drawn is a
  **BLOCKER**, not a style difference.

**3. Copy**
- *(always)* Nothing reads `lorem`, `TODO`, `xxx`, `{{…}}`, `undefined`, `NaN`, or `[object Object]`. Text that
  differs from the baseline is not a finding.

**4. Colour and type**
- *(design)* Colour roles hold — a primary action rendered with a secondary's weight, or the reverse, is a
  **BLOCKER**. The type hierarchy separates the levels the baseline separates.
- *(always)* Body text and interactive labels clear 4.5:1 against their real background. Compute it from
  `getComputedStyle()`; never estimate contrast off a screenshot.

**5. Geometry** — where the baseline rule bites, so read this one whole.
- *(always)* No two siblings overlap. No text is clipped or ellipsised where the whole string is what the user
  needs. `driving-the-browser.md`'s `elementFromPoint` occlusion snippet asks this of a different element, so
  reuse it rather than writing a second one.
- *(desktop scenarios)* `documentElement.scrollWidth - clientWidth === 0`. The phone replay already asserts this
  and already files the bug — **do not assert it twice**; ask it on desktop, where nothing does.
- *(phone replays)* Every control the replay drove is at least 44px on its short side.
- *(design)* Compare margin, padding, gap, border width, radius and element size. A visible
  difference from the baseline is a **BLOCKER**. Describe the visual difference; do not claim an
  exact pixel value from the image unless the browser supplies that measurement.

**6. States**
- *(design)* Every state the baseline draws is reachable and rendered: empty, loading, error, selected,
  disabled. One the build never renders → **BLOCKER**.
- *(always)* Loading, empty and error each render something deliberate. A blank region, a bare spinner where
  content belongs, or a raw stack trace on screen is a finding.

**One question needs driving, and Step 4 owns it.** Content longer than the fixture — a long name, a long label,
a number with more digits — is the check most worth having, because a layout that survives seeded data and
breaks on a real customer's name breaks in production and not here. It is an attack, not a look, so it is driven
as a Step 4 probe under that step's rules, not from this file.

**Every question is answered.** A finding names the element, the visual difference and both image
paths. A pass you did not look for is not a pass. "Looks off" is not a
finding; say what differs.

## What it produces

**The fidelity is derived, never chosen.** Start at 100, subtract 25 per BLOCKER and 8 per HIGH, floor at 0;
things the rule called not-a-finding subtract nothing. A number picked because the screen felt close is the
thing this field exists to prevent. It is `null` wherever the baseline is. **Below 80 with no BLOCKER is a finding
on the scenario, not a fail** — say it in `reason` and let the reader weigh it.

Each finding names both files, what the design shows, what the build shows, and the evidence:

```
BLOCKER — the empty state is never rendered
  baseline: design/invoices-empty.png
  actual:   verification/screenshots/04_invoices_empty__03_empty.png
  design:   an illustration and "No invoices yet — import one to begin" fill the table region
  built:    the table region is 0px tall with the list empty
  evidence: getBoundingClientRect() on [data-testid=invoice-table] → {height: 0, top: 214}
```

Then route what you found:

- **Any visual mismatch** — mark the scenario `FAILURE`, which makes the overall verdict `FAIL`.
  Promote the staged screenshot as failure evidence and include both final paths in the finding.
- **Everything else, and the fidelity** — the scenario's `visualMatch`.

**Done when** every frame has been through all six questions with each answer evidenced or called clean; every
scenario carries a `visualMatch` whose fidelity is derived from graded findings, or names the absent baseline;
every visual mismatch has made its scenario a `FAILURE`; and every mismatch names the reference,
promoted screenshot and observed difference.
