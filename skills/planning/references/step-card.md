# The step card — one contract, two renderings

An implementation step is a **card**. `phases/phase-N.md` and the `#phases` drill-down in
`plan.html` are two **renderings** of the same card.

Write the card once, in the phase file. Then **transcribe** it into the drill-down. The
drill-down has no content of its own, so the two cannot drift.

## Contents

- [The parts](#the-parts)
- [How to use the table](#how-to-use-the-table)
- [Show the change as a diff](#show-the-change-as-a-diff)
- [Addresses](#addresses)
- [Designs](#designs)
- [Register](#register)
- [What earns a step](#what-earns-a-step)
- [One step, both renderings](#one-step-both-renderings)

## The parts

| Part | Include when | In `phase-N.md` | In the drill-down |
|---|---|---|---|
| **Title** — the action and its file | always | `1. **Change \`src/x.ts:31-40\`**` | `<div class="it">` |
| **What it does** — the contract, or the ordered logic including the branch and the error path | always | prose under the title | `<p>` |
| **Diff** — the change, as a unified diff | the step writes or changes code | a line naming the file and range, then a ```` ```diff ```` block | `.snip-lbl.diff` naming the file and range, then `<pre class="diff"><code>` |
| **Pattern** — existing code to imitate, plus the reason it is shown | the step copies a shape from elsewhere rather than changing that code | fenced block, reason on the line above | `.snip-lbl.cur` with a `.why`, then `<pre>` |
| **Design** — the frame this step builds to | the step builds a surface a design defines | `build to design/x.png` | `<details class="media">` with the image |
| **Why this way** — the rejected alternative, or the constraint | the location or shape had a plausible alternative | closing sentence | `.rule` |
| **Trap** — what breaks if the developer does the obvious thing | code that looks safe to change and is not | its own paragraph | `.rule.trap` |

## How to use the table

**Order comes from the phase file.** The transcription keeps whatever order the step used. This
table lists the parts; it does not sequence them.

**Parts are triggered, not filled.** An omitted part costs nothing. A padded part states
"considered, nothing found" — a claim you did not mean to make.

**One part is not triggered — it is owed.** Where `design/INDEX.md` names a frame for the surface
a step builds, that step's Design part is required. See Designs below.

**A step can say something that is none of them.** The parts are what recurs, not a grammar of
everything a step may contain. An environment warning, or a note about how to see the change, is
plain prose in both renderings.

## Show the change as a diff

Every change the developer makes is a **unified diff**: removed lines open with `-`, added lines
with `+`, unchanged context lines with a space, and a hunk header `@@ -from,count +to,count @@`
separates hunks. The reader sees what goes and what comes in one block, in the file's own order,
instead of holding a before block and an after block side by side in their head.

- **A new file** is one block of `+` lines, every line of it.
- **A change inside an existing file** carries at least one context line on each side of the
  change, so the developer finds the spot without a line number — and a hunk header when the
  file's line numbers are known, so they find it with one.
- **Two changes in one file, apart from each other** are two hunks in one block, each with its
  own header, never a scroll of context between them.
- **A moved block** is `-` lines where it was and `+` lines where it goes, in the same block.
- **A rename or a one-token edit** is still a diff: `-` the old line, `+` the new. A prose
  instruction to "change X to Y" makes the developer reconstruct the line the diff hands them.

Keep a diff as long as the change and no longer. Context beyond a line or two claims the change is
self-contained when it is not, and a hunk long enough to scroll is a hunk the developer will skim.

Existing code that the step does not change appears under exactly one trigger: the step **imitates**
it. Then it is a plain fenced block under `.snip-lbl.cur` **with the reason it is on the page** —
`bull-queue.ts:1678 — createFlow, the parent-plus-children builder`. Unlabeled current code reads
as the target state, and the developer builds it. Where the step changes that code instead, the
old lines belong in the diff as `-` lines, not in a second block.

**The verifier reads every `pre.diff`.** A line that opens with anything but `+`, `-`, `@@` or a
space fails the plan gate, and so does an empty block. In the HTML rendering `<`, `>` and `&`
are escaped; the engine colours the lines from their first character, so nothing is hand-marked.

## Addresses

A line reference is an **address**. Give one where the developer must open that spot — the code
they change, delete, move, or replace — and name what is there:
`header.js:859-972 — the AccountMenu memo`. Repo-relative always. The diff label carries the
address for a change; the title repeats it only when the step has no diff.

Everywhere else, state the fact. "The same business check already guards the Frill container and
the menu button" is complete where they read it. Where they must keep something exactly, quote it;
where a call site would fit in four lines, show the lines as a diff. An address asks them to fetch
what the step could have handed them.

## Designs

A step that builds to a design embeds the frame, with a one-line caption naming what it settles.
Two steps using the same frame both embed it — the shell embeds each file once and wires it to
every use, so repeats cost nothing. The phase card above the steps also shows every frame the
phase builds to, open, in its `.builds` strip; the step's panel is the close-up beside the work.

Where a frame exists the panel is not optional, and prose is not a substitute for it. The PRD
states the rule; the frame settles what the rule leaves open — spacing, order, variant, the exact
words of an empty state. A step that cites the text and drops the frame hands the coder the half
that does not constrain pixels.

**The style facts a frame settles** — the list to read off it, and to carry in the step's
contract: element order · spacing · type scale and weight · colour role · component variant ·
divider placement · icon · empty-state copy word for word. Planning's steps 1 and 2 mean this
list; it is defined here and nowhere else.

In the drill-down the frame is a panel, and a panel is three parts — summary, `.d-body`, content:

```html
<details class="media">
  <summary>Design — the name block hovered</summary>
  <div class="d-body">
    <img data-img="menu-super-admin-hover.png" alt="User menu with the name block highlighted">
    <div class="cap">Settles how far the hover background extends across the name block.</div>
  </div>
</details>
```

The summary is what the reader clicks and the only thing they see closed, so it names the frame's
subject, not the file. Drop it and the shell's engine derives one from the caption or the alt text
— serviceable, never the line you would have written, and "Details" when there is nothing to
derive from.

The file a `data-img` names must also have an entry in the page's `IMG` map, or the panel renders
blank. That map is generated, never typed: `scripts/inline-designs.ts` base64s every frame the
page references into it.

Where no design exists, say so in the step. A surface with no design is one the developer is
authorized to invent, and that is worth one clause where the work happens.

## Register

Write each step the way you would say it to a colleague sitting next to you with the file already
open. A step is finished when a developer who was not in this conversation can act on it after one
read. Two habits carry most of it:

**Open with an imperative verb.** Every step title, and every step's first sentence, starts with
the action: Create · Change · Move · Delete · Add · Replace.

**Name the change, not the effect.**

| Instead of | Write |
|---|---|
| the avatar grows to 32px | Change it to 32 |
| a component that reads the store needs a store to be constructed in a test | if it reads the store itself, every test has to build a store first |
| leaves the memo stale | the memo returns stale output |
| copied as-is that ships a blank gap where the label belongs | if you copy it as-is, it prints a blank where the label should be |

## What earns a step

A step carries a new function's design, a new file's location, a change to an existing type or
signature, or an algorithm whose correctness is not obvious.

A step that is only "modify X to do Y" is mechanical — the developer sees it on opening the file.
Reduce it to a one-line note, or cut it. Steps are not a change list.

## One step, both renderings

In `phases/phase-N.md`:

````markdown
2. **Reject duplicate emails in `src/services/user.ts:31 — createUser`**

   Look up the address before inserting. When the lookup returns a row, throw
   `DuplicateError(email)`. The happy path does not change.

   `src/services/user.ts:31-33`

   ```diff
   @@ -31,3 +31,4 @@
    export async function createUser(email: string, name: string) {
   +  if (await findByEmail(email)) throw new DuplicateError(email)
      const user = await users.insert({ email, name })
   ```

   Use `findByEmail` rather than catching the unique-index error: the constraint error does not
   say which column collided.
````

In the drill-down:

```html
<li>
  <div class="it">Reject duplicate emails in <code>src/services/user.ts:31 — createUser</code></div>
  <p>Look up the address before inserting. When the lookup returns a row, throw
  <code>DuplicateError(email)</code>. The happy path does not change.</p>
  <div class="snip-lbl diff">Change <code>src/services/user.ts:31-33</code></div>
  <pre class="diff"><code>@@ -31,3 +31,4 @@
 export async function createUser(email: string, name: string) {
+  if (await findByEmail(email)) throw new DuplicateError(email)
   const user = await users.insert({ email, name })</code></pre>
  <div class="rule"><b>Why this way</b>Use <code>findByEmail</code> rather than catching the
  unique-index error: the constraint error does not say which column collided.</div>
</li>
```

Same title, same order, same diff, with `<`, `>` and `&` escaped. It adds nothing.
