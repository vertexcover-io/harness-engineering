# The step card

An implementation step in `phases/phase-N.md` is a **card**: a fixed set of parts. The card
governs where things go and what they are called. It never governs how much a step says.

## The parts

| Part | Include when | How it is written |
|---|---|---|
| **Title**: the action and its file | always | `1. **Change \`src/x.ts:31-40\`**` |
| **What it does**: the contract, or the ordered logic with the branch and the error path | always | prose under the title |
| **Diff**: the change | the step writes or changes code | a line naming the file and range, then a ```` ```diff ```` block |
| **Pattern**: existing code to imitate | the step copies a shape from elsewhere rather than changing that code | a fenced block, with the reason it is shown on the line above |
| **Design**: the frame this step builds to | the step builds a surface a design defines | `build to design/x.png` |
| **Why this way**: the rejected alternative, or the constraint | the location or shape had a plausible alternative | closing sentence |
| **Trap**: what breaks if the developer does the obvious thing | code that looks safe to change and is not | its own paragraph |

Parts are triggered, not filled. An omitted part costs nothing; a padded part states
"considered, nothing found". The one part that is owed: where `design/INDEX.md` names a frame
for the surface a step builds, that step's Design part is required.

A step can also say something that is none of these. An environment warning, or a note on how
to see the change, is plain prose.

## Show the change as a diff

Every change is a **unified diff**: removed lines open with `-`, added lines with `+`, context
lines with a space, and a hunk header `@@ -from,count +to,count @@` separates hunks. A
before-and-after pair makes the coder rebuild what the diff hands them.

- **A new file** is one block of `+` lines, every line of it.
- **A change inside a file** carries at least one context line on each side, and a hunk header
  when the line numbers are known.
- **Two changes apart in one file** are two hunks in one block, each with its header.
- **A moved block** is `-` lines where it was and `+` lines where it goes.
- **A rename or one-token edit** is still a diff: `-` the old line, `+` the new.

Keep a diff as long as the change and no longer. Every line in the block opens with `+`, `-`,
`@@` or a space.

Existing code the step does not change appears only when the step **imitates** it, as a plain
fenced block with the reason above it: `bull-queue.ts:1678 — createFlow, the
parent-plus-children builder`. Unlabeled current code reads as the target state, and the coder
builds it.

## Addresses

A line reference is an **address**. Give one where the developer must open that spot, the code
they change, delete, move or replace, and name what is there:
`header.js:859-972 — the AccountMenu memo`. Repo-relative always. The diff label carries the
address for a change; the title repeats it only when the step has no diff.

Everywhere else, state the fact. Where they must keep something exactly, quote it. An address
asks them to fetch what the step could have handed them.

## Designs

A step that builds to a design names the frame, with one line saying what it settles. Prose is
not a substitute: the ticket states the rule, and the frame settles what the rule leaves open.

**The style facts a frame settles**, to read off it and carry in the step's contract: element
order · spacing · type scale and weight · colour role · component variant · divider placement ·
icon · empty-state copy word for word.

Where no design exists, say so in the step. A surface with no design is one the developer is
authorized to invent.

## Register

Write each step the way you would say it to a colleague with the file already open. A step is
finished when a developer who was not in this conversation can act on it after one read.

**Open with an imperative verb**: Create · Change · Move · Delete · Add · Replace.

**Name the change, not the effect.**

| Instead of | Write |
|---|---|
| the avatar grows to 32px | Change it to 32 |
| leaves the memo stale | the memo returns stale output |
| copied as-is that ships a blank gap where the label belongs | if you copy it as-is, it prints a blank where the label should be |

## What earns a step

A step carries a new function's design, a new file's location, a change to an existing type or
signature, or an algorithm whose correctness is not obvious. A step that is only "modify X to do
Y" is mechanical: reduce it to a one-line note, or cut it. Steps are not a change list.

## One step

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
