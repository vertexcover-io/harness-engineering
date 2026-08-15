# The step card — one contract, two renderings

An implementation step is a **card**. `phases/phase-N.md` and the `#phases` drill-down in
`plan.html` are two **renderings** of the same card.

Write the card once, in the phase file. Then **transcribe** it into the drill-down. The
drill-down has no content of its own, so the two cannot drift.

## The parts

| Part | Include when | In `phase-N.md` | In the drill-down |
|---|---|---|---|
| **Title** — the action and its file | always | `1. **Create \`src/x.ts\`**` | `<div class="it">` |
| **What it does** — the contract, or the ordered logic including the branch and the error path | always | prose under the title | `<p>` |
| **New code** — what the developer writes | the step writes or changes code | fenced block | `.snip-lbl.new` + `<pre>` |
| **Existing code** — plus the reason it is shown | one of the three triggers below | fenced block, reason on the line above | `.snip-lbl.cur` with a `.why` |
| **Design** — the frame this step builds to | the step builds a surface a design defines | `build to design/x.png` | `<details class="media">` with the image |
| **Why this way** — the rejected alternative, or the constraint | the location or shape had a plausible alternative | closing sentence | `.rule` |
| **Trap** — what breaks if the developer does the obvious thing | code that looks safe to change and is not | its own paragraph | `.rule.trap` |

## How to use the table

**Order comes from the phase file.** The transcription keeps whatever order the step used. This
table lists the parts; it does not sequence them.

**Parts are triggered, not filled.** An omitted part costs nothing. A padded part states
"considered, nothing found" — a claim you did not mean to make.

**A step can say something that is none of them.** The parts are what recurs, not a grammar of
everything a step may contain. An environment warning, or a note about how to see the change, is
plain prose in both renderings.

## Show the code the developer is about to write

The default snippet is the **new** state, under `.snip-lbl.new` — "What you write" or "What you
change".

Existing code appears under exactly three triggers:

- the step moves it verbatim
- the developer must locate the block before replacing it
- a library rule explains why the obvious fix does not work

Then it carries `.snip-lbl.cur` **and the reason it is on the page**. Unlabeled current code reads
as the target state, and the developer builds it.

Quote what the step changes. Where a step imitates a pattern instead, name it
(`bull-queue.ts:1678 — createFlow, the parent-plus-children builder`) and let the developer read it
whole. Elide a before-block to the lines that matter and an after-block to the changed lines: a
quote long enough to scroll claims the change is self-contained when it is not.

## Addresses

A line reference is an **address**. Give one where the developer must open that spot — the code
they change, delete, move, or replace — and name what is there:
`header.js:859-972 — the AccountMenu memo`. Repo-relative always.

Everywhere else, state the fact. "The same business check already guards the Frill container and
the menu button" is complete where they read it. Where they must keep something exactly, quote it;
where a call site would fit in four lines, show the lines. An address asks them to fetch what the
step could have handed them.

## Designs

A step that builds to a design embeds the frame, with a one-line caption naming what it settles.
Two steps using the same frame both embed it — the shell embeds each file once and wires it to
every use, so repeats cost nothing.

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

   Look up the address before hashing. When the lookup returns a row, throw
   `DuplicateError(email)`. The happy path does not change.

   ```ts
   if (await findByEmail(email)) throw new DuplicateError(email)
   ```

   Use `findByEmail` rather than catching the unique-index error: the constraint error does not
   say which column collided.
````

In the drill-down:

```html
<li>
  <div class="it">Reject duplicate emails in <code>src/services/user.ts:31 — createUser</code></div>
  <p>Look up the address before hashing. When the lookup returns a row, throw
  <code>DuplicateError(email)</code>. The happy path does not change.</p>
  <div class="snip-lbl new">What you write</div>
  <pre><code>if (await findByEmail(email)) throw new DuplicateError(email)</code></pre>
  <div class="rule"><b>Why this way</b>Use <code>findByEmail</code> rather than catching the
  unique-index error: the constraint error does not say which column collided.</div>
</li>
```

Same title, same order, same code, with `<`, `>` and `&` escaped. It adds nothing.
