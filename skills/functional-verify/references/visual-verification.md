# Visual Verification

**Read this when:** a scenario's frames are shot and their asserts have passed, before you write the scenario up
(Step 2). You are mid-walk with the session still open, which is what makes this cheap.

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

Where `plan.md`'s `## Design References` names an image for the screen — a mockup, a Figma export, a photo of a
whiteboard — **that image is the baseline**, and the questions marked *(design)* below have an answer.

**It is authoritative about intent, not about measurement.** A supplied image routinely carries spacing nobody
decided: padding off the grid, gaps that differ between two rows of the same list, a margin that is wherever the
author's cursor landed. Grading against those numbers produces a long list of findings that are all noise and
buries the one that mattered.

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

- **BLOCKER** — the build does not do what the design says. Its scenario is a `FAILURE`, and the divergence is a
  bug: filmed from its own repro in Step 4, with a `bugs[]` entry like any other.
- **HIGH** — the build says something different from the design, or the screen is degraded on its own terms.
  A finding on the scenario, not a hard fail.
- **Not a finding** — the difference is a number, and nothing turns on it. Report nothing at all: no
  `findings[]` entry, nothing off the fidelity, no note in `extra[]`.

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
- *(design)* Text differing in **meaning** rather than casing or punctuation → **BLOCKER**.
- *(always)* Nothing reads `lorem`, `TODO`, `xxx`, `{{…}}`, `undefined`, `NaN`, or `[object Object]`.

**4. Colour and type**
- *(design)* Colour roles hold — a primary action rendered with a secondary's weight, or the reverse, is a
  **HIGH**. The type hierarchy separates the levels the baseline separates.
- *(always)* Body text and interactive labels clear 4.5:1 against their real background. Compute it from
  `getComputedStyle()`; never estimate contrast off a screenshot.

**5. Geometry** — where the baseline rule bites, so read this one whole.
- *(always)* No two siblings overlap. No text is clipped or ellipsised where the whole string is what the user
  needs. `driving-the-browser.md`'s `elementFromPoint` occlusion snippet asks this of a different element, so
  reuse it rather than writing a second one.
- *(desktop scenarios)* `documentElement.scrollWidth - clientWidth === 0`. The phone replay already asserts this
  and already files the bug — **do not assert it twice**; ask it on desktop, where nothing does.
- *(phone replays)* Every control the replay drove is at least 44px on its short side.
- *(design)* **A margin, padding, gap, border width, radius or element size that differs from the baseline is
  not a finding.** Two things look like one and are not, so test for both before dropping it:
  1. **It broke something above.** The overflow, the overlap, the clipped label. **The break is the finding** —
     report what broke and the measurement that shows it, and say the baseline is not the authority for what the
     value should become. Proving the break is your job; choosing the new number belongs to whoever owns the
     design.
  2. **It changed what the screen says.** A gap so much wider that one group now reads as two; an element so
     much smaller that it drops out of the hierarchy it was drawn into. That is a **HIGH**, graded by what the
     screen now communicates and never by the pixel count — which is the number you were told not to trust.

  Neither test has a threshold, and do not invent one. *Did something break?* and *does the screen say something
  different now?* Two noes means drop it and say nothing.

**6. States**
- *(design)* Every state the baseline draws is reachable and rendered: empty, loading, error, selected,
  disabled. One the build never renders → **BLOCKER**.
- *(always)* Loading, empty and error each render something deliberate. A blank region, a bare spinner where
  content belongs, or a raw stack trace on screen is a finding.

**One question needs driving, and Step 4 owns it.** Content longer than the fixture — a long name, a long label,
a number with more digits — is the check most worth having, because a layout that survives seeded data and
breaks on a real customer's name breaks in production and not here. It is an attack, not a look, so it is driven
as a Step 4 probe under that step's rules, not from this file.

**Every question is answered.** A finding with its evidence, or explicitly clean. A pass you did not look for is
not a pass, and "looks off", "spacing feels wrong", "colours are a bit different" are not findings — name the
element and quote the observation, or you have not looked closely enough to report it.

## What it produces

**The fidelity is derived, never chosen.** Start at 100, subtract 25 per BLOCKER and 8 per HIGH, floor at 0;
things the rule called not-a-finding subtract nothing. A number picked because the screen felt close is the
thing this field exists to prevent. It is `null` wherever the baseline is. **Below 80 with no BLOCKER is a finding
on the scenario, not a fail** — say it in `reason` and let the reader weigh it.

Each finding names what the design shows, what the build shows, and the evidence that settles it:

```
BLOCKER — the empty state is never rendered
  design:   an illustration and "No invoices yet — import one to begin" fill the table region
  built:    the table region is 0px tall with the list empty
  evidence: getBoundingClientRect() on [data-testid=invoice-table] → {height: 0, top: 214}
```

Then route what you found:

- **Any BLOCKER, and any finding a user would be wrong-footed by** — a bug. Step 4 films it from its own repro
  and it earns a `bugs[]` entry with its `reachedBy` and `origin`, like every other bug.
- **Everything else, and the fidelity** — the scenario's `visualMatch`.
- **Cosmetic drift nobody would be wrong-footed by** — a note in `extra[]`, as it always was.

**Done when** every frame has been through all six questions with each answer evidenced or called clean; every
scenario carries a `visualMatch` whose fidelity is derived from graded findings, or names the absent baseline;
no finding rests on a number alone; and every BLOCKER has become a bug with a repro.
