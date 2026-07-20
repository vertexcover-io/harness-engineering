# Driving the Browser: What the CLI's Own Guide Won't Tell You

The CLI ships its own guide, version-matched to the binary, and it is authoritative on the
basics — session/refs/snapshot, the `wait` verbs, viewports, tabs, `record`:

```bash
agent-browser skills get core          # ~475 lines. Look things up here.
agent-browser skills get core --full   # ~2400 lines. A lookup surface, not a read.
```

Reach for it when a command's flags aren't obvious. Don't read it front-to-back — `--full` is
roughly 19k tokens and this skill is round-trip-bound already.

This file is the complement: the things that guide **doesn't** say. Everything below was proven on a
real run, not inferred, and none of it depends on which app you're driving.

What *does* depend on the app — how login works, which surfaces lie about their own state, whether a
dev overlay is in the way — is knowledge the project owns, and it will save you more time than
anything here. Look for it before your first `open`; a project that has been verified before has
usually written its traps down.

Use the binary directly, never `npx agent-browser` — `npx` routes through Node instead of the Rust
client and pays that cost on every call.

Chrome may need `agent-browser --args "--no-sandbox" open <url>` on Linux — without it the launch
dies on `No usable sandbox!` and every later command reports a dead session.

## Round-Trip Economy: Batch or Bleed

A verification run is not slow because the browser is slow. One real run spent 23.8 minutes in
tools and ~51 minutes in model round-trips, issuing 295 browser operations across 121 Bash calls.
The fix is `batch`, which runs many commands in one invocation and returns a JSON array of results.

**Pipe JSON on stdin; don't pass commands as arguments.** Argument mode lets the shell word-split
your JS and eat the quotes — `'no-title'` arrives as `no-title` and `#content` as `content`, so the
eval fails on an identifier that never existed. Stdin mode passes each argument verbatim:

```bash
cat <<'EOF' | agent-browser batch --json
[["eval","(()=>document.querySelectorAll('[data-testid^=row-]').length)()"],
 ["screenshot","verification/VS-1/03-add-row.png"]]
EOF
```

**Setup bails; evidence does not.** `--bail` stops the batch on the first *error*, which is right
for `open → auth → navigate` — asserting against a page that never loaded proves nothing. It is
wrong for act→assert→capture, and the reason is exact: an assert that **returns false** is a
*success* (`success: true`, result `false`) and does not bail, but an assert that **throws** is an
error and does bail — taking the screenshot after it with it. That loses the picture precisely when
the assert failed, which is when you most needed it. So write asserts that return a value, read the
value from `--json`, and keep `--bail` on the setup batch only.

## The Laws of `eval`

**Wrap every eval in an IIFE.** `eval` runs in one persistent global scope, so a top-level `const`
succeeds on the first call and throws `SyntaxError: Identifier 'el' has already been declared` on
the second. `(()=>{ ... })()` is immune. Note `eval --stdin` fixes *quoting*, not scope — the two
are orthogonal, and the upstream guide's own example models the bug by declaring `const` at top
level.

**One action per batch entry.** A throwing eval silently abandons every statement after it in the
same script. Chain a helper and an action together and the helper's failure looks exactly like a
click that missed — the action never ran, and nothing says so.

**An assert that can pass vacuously is not an assert.** `[].every(f)` is `true`, so
`nodes.every(n => n.checked)` reports success over a selector that matched nothing — and reads
exactly like the real thing. Two separate runs shipped this: one "proved" every row visible on a page
with no rows, one "proved" it had restored columns it never touched. Return the count beside the
verdict (`{n: nodes.length, ok: nodes.every(...)}`) and treat `n: 0` as a failed lookup, never a pass.

**Collapse whitespace before matching `innerText`.** `innerText` inserts newlines at layout
boundaries, so `/No Records Found/` misses text the page plainly shows and hands you a confident
`false`. Match against `el.innerText.replace(/\s+/g,' ')`.

**Never measure in the same batch as the action that moves things.** A rect read in the batch that
scrolled is a rect from mid-scroll. Act, `wait` on the condition, then measure in the next batch.

**A rect inside the viewport is not a visible element.** `getBoundingClientRect()` cannot see
occlusion, so a cell under a sticky overlay measures `visible: true` while the frame shows it
covered. Ask the page what is actually on top:

```js
(()=>{const r=el.getBoundingClientRect();
      const top=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
      return {covered: !(el===top || el.contains(top))};})()
```

`agent-browser set viewport <w> <h>` — the bare `viewport` verb does not exist.

Framing is a gate, so it lives inline in the skill's Step 4 rather than here.
