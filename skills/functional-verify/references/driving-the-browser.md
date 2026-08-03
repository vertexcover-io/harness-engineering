# Driving the Browser

**Read this when:** driving UI scenarios (Step 2), or re-driving a bug's repro (Step 4). Everything here is done
with a browser open; grading, videos, and the report are in `writing-the-report.md`.

What depends on the app — how login works, which surfaces lie about their own state, whether a dev overlay is in
the way — is knowledge the project owns, held in its own skills and `CLAUDE.md`. Look for it before your first
`open`; a project that has been verified before has usually written its traps down.

## Setup

Use the binary directly (`npx` routes through Node instead of the Rust client and pays that cost on every call). On
Linux, launch with `agent-browser --args "--no-sandbox" open <url>` — without it Chrome dies on `No usable
sandbox!` and every later command reports a dead session. Set `AGENT_BROWSER_DEFAULT_TIMEOUT=2000` so a wait that
will never resolve fails in 2s rather than the 30s default.

The CLI ships its own guide, version-matched to the binary and authoritative on the basics — session/refs/snapshot,
the `wait` verbs, viewports, tabs, `record`:

```bash
agent-browser skills get core          # ~475 lines. Look things up here.
agent-browser skills get core --full   # ~2400 lines (~19k tokens). A lookup surface, not a read.
```

Reach for it when a command's flags aren't obvious.

## The rules

A verification run is slow in the round-trips, not in the browser, so `batch` — many commands per invocation,
returning a JSON array of results — is the workhorse.

- **Pipe JSON on stdin** (argument mode lets the shell word-split your JS and eat the quotes), **one action per
  batch entry**.
- **Wrap every `eval` in an IIFE** — `eval` runs in one persistent global scope, so a top-level `const` throws
  `Identifier already declared` on the second call. `eval --stdin` fixes quoting, not scope.
- **Return a value from asserts and read it from `--json`.** Keep `--bail` on the setup batch (`open → auth →
  navigate`) only: an assert that *returns false* is a success and doesn't bail, but an assert that *throws* is an
  error and takes the screenshot after it down with it — losing the picture exactly when you needed it.
- **Return the count beside the verdict and treat `n: 0` as a failed lookup.** `[].every(f)` is `true`, so
  `nodes.every(n => n.checked)` reports success over a selector that matched nothing and reads exactly like the real
  thing. `{n: nodes.length, ok: nodes.every(...)}`.
- **Match `innerText` after `.replace(/\s+/g,' ')`** — it inserts newlines at layout boundaries.
- **Measure in the batch *after* the one that moved things.** Act, `wait` on the condition, then measure.
- **`wait` on the real condition** — `wait --text`, `--url`, `--load networkidle`, or `wait @eN` return the moment
  the state holds.

```bash
cat <<'EOF' | agent-browser batch --json
[["eval","(()=>document.querySelectorAll('[data-testid^=row-]').length)()"],
 ["screenshot","<staging>/01_add_row__03_row_added.png"]]
EOF
```

## Catching a self-dismissing element

A toast, a flash banner, a spinner is gone by the next batch, so click, `wait` for it, then assert and screenshot
together in one batch, in this order:

```bash
cat <<'EOF' | agent-browser batch --json
[["click","[data-testid=save]"],
 ["wait",".toast"],
 ["eval","(()=>{const t=document.querySelector('.toast');return {shown:!!t,text:t?.innerText}})()"],
 ["screenshot","<staging>/03_save__04_toast_confirms.png"]]
EOF
```

The `wait` is load-bearing: the toast appears only after the request the click fires, so without it you shoot the
empty gap before the toast exists. Real toasts live seconds, so this covers almost everything; how long *this*
app's toasts stay up is a project fact.

**When the element lives too briefly for `wait` to catch it** (`wait` reaches down to ~150ms), block the batch on
the element's arrival instead. One `eval` arms a `MutationObserver`, fires the action, and returns a Promise that
resolves the moment the element lands; `eval` awaits that Promise, so the screenshot in the next batch entry lands
while the element is still on screen:

```bash
cat <<'EOF' | agent-browser batch --json
[["eval","(()=>new Promise(res=>{const sel='[data-testid=flash]';const t0=Date.now();const done=v=>{obs.disconnect();clearTimeout(timer);res(v)};const obs=new MutationObserver(()=>{const el=document.querySelector(sel);if(el)done({appeared:true,ms:Date.now()-t0,text:el.innerText})});obs.observe(document.body,{childList:true,subtree:true});const timer=setTimeout(()=>done({appeared:false,ms:Date.now()-t0}),2000);document.querySelector('[data-testid=save]').click()}))()"],
 ["screenshot","<staging>/05_save__03_flash_confirms.png"]]
EOF
```

The order inside the eval is load-bearing: **observe → arm the timeout → click**, then resolve on arrival. Arming
after the click is the race you came here to close. It must be a `MutationObserver` rather than an event listener,
because the element does not exist yet — there is no node to attach to. The `setTimeout` guarantees the Promise
always settles, so a batch can never hang; when it resolves `{appeared: false}`, record the element `NOT VERIFIED`
with the `ms` lifetime you measured.

## The capture loop — act, assert, capture to staging, promote

**Film the whole life of the scenario, not a checklist of its steps.** The frames are what a reviewer watches to
believe you, so shoot whatever the flow needs end to end: the state you started from, the data you seeded, each
step, the intermediate render that explains why the next click works, the toast that confirms it. Every step earns
at least one frame, many earn more — a scenario with more *promoted* frames than steps is doing it right.

**Capture to staging, promote only what you verified.** A frame is evidence once its assert passed *and* your own
eyes confirmed it. Shoot into `.harness/<SPEC_NAME>/verify-staging/` — scratch, a sibling of `verification/` and
never part of it — and move a frame into `screenshots/` only once it earns its place. Re-takes, dead ends, and
missed clicks stay in staging and are discarded at cleanup.

For every action, run one batch that acts, asserts, and captures **to staging**:

```bash
cat <<'EOF' | agent-browser batch --json
[["eval","(()=>document.querySelector('[data-testid=add-more]').click())()"],
 ["eval","(()=>({n: document.querySelectorAll('[data-testid^=row-]').length}))()"],
 ["screenshot","/abs/path/to/.harness/<SPEC_NAME>/verify-staging/02_half_rupee_gap_matches__03_rows_added.png"]]
EOF
```

**Write the screenshot path absolute** — the heredoc is quoted and your shell's cwd resets between calls.

Then **`Read` the staged PNG and confirm it shows what you think** — the round-trip you never skip. Once the assert
passed and your eyes confirmed the frame, **promote it**: `mv` it into `verification/screenshots/` under its
`NN_<slug>__SS_<step>.png` name, and record the assert's deciding value (the returned `{n: …}`, the measured rect,
the quoted string) for the scenario's `reason`.

You need both checks. **The assert answers whether the state took hold** — a click that silently no-ops looks
identical to one that worked until you ask the DOM. **The Read answers whether the frame shows it.** When they
disagree, re-drive rather than promote: the frame usually lags the render (`wait` on the condition and re-shoot),
but check the assert too — it may have matched `innerText` across a line break, measured a rect in the same batch as
the scroll that moved it, or passed vacuously over a selector that matched nothing. Settle it by asking the page a
second way.

**A file the scenario downloads is evidence — keep it** beside the report as `verification/NN_<slug>.<ext>`, the
same prefix as its video, and list it in the scenario's `artifacts[]`.

Frame a non-feature element at the top and bottom edge of each shot, so the frame carries the feature's neighbours:
a sticky bar landing mid-page, orphaned actions, and a header misaligned once the feature mounts are all bugs only a
wider shot catches. Read the page's expected top-level section ordering from the project's skills or layout — that
ordering is a layout invariant your frames must uphold. Prefer a cropped or clipped shot over full-page: it keeps
the frame readable at video size.

## The frame that proves it

Every scenario turns on a few facts held together — *these two numbers differ by this much, and the verdict says
this*. **Get them into one frame.** Work in this order, and stop as soon as the shot holds:

1. **Use the app's own controls** — a column chooser, a density toggle, a collapse. Cheapest and most honest.
   **Restore what you changed** — these settings persist for the account you're driving.
2. **Set the viewport to fit** — `agent-browser set viewport 1600 900`. Yours to choose, costs nothing.
3. **Only if neither works, overlap.** Keep an identifying column in every frame so the shots stitch, and say in the
   report that the evidence spans frames.

Then check the shot actually shows what you think — **a rect inside the viewport is not a visible cell.**
`getBoundingClientRect()` is blind to occlusion: a sticky overlay over the value column measures `visible: true` and
photographs as covered. Ask the page what is on top of each cell:

```js
(()=>{const r=el.getBoundingClientRect();
      const top=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
      return {covered: !(el===top || el.contains(top))};})()
```

**Every cell the frame is offered as evidence for must be un-occluded at its own centre, and the row must be
identifiable in that same frame.**

## Replaying the scenario on a phone

`agent-browser set device "iPhone 14"` — a **device**, not a narrow viewport. An app that branches on user-agent or
touch rather than width serves its desktop layout to a resized window, and you photograph a mobile pass that never
happened.

**Replay, don't re-shoot.** Set the device, then drive the walk again from its first click — the same batches and
the same asserts as the desktop run, under the replay's own `NN_<slug>`. Switching device at the end and
re-shooting the last screen proves one layout and nothing about how a phone reaches it: the CTA behind a hamburger
that no longer opens, the touch handler that never fires, the sticky footer sitting on the submit button all live
on the path that gets skipped. Restore the desktop device afterwards, as with any setting you changed.

The replay carries a verdict, so the walk answers the same question it answered on desktop:

- **The closing assert returns the value it returned on desktop** — the outcome, not a similar-looking screen. This
  is what the scenario's `expected` already claims, now claimed at phone width.
- **Nothing scrolls sideways** — `(()=>({over: document.documentElement.scrollWidth -
  document.documentElement.clientWidth}))()` returns `0`. Anything above zero is a bug with its measurement already
  attached.
- **Every element a frame is offered as evidence for is un-occluded at its centre**, by the `elementFromPoint` check
  above — the narrow layout is exactly where a sticky bar lands on top of what you photographed.
- **Controls are reached the way the phone presents them** — driven through the menu the layout collapsed them into,
  never bypassed by clicking a node the user cannot see.

A replay that fails is a `Failure` scenario and a `bugs[]` entry like any other, and its `reachedBy` writes itself:
the user on that device, and the surface they touched.

**Done when every scenario has a `NN_<slug>` set of promoted frames in `screenshots/` telling its whole story, each
one backed by a passing assert and your own eyes.**
