# Making a change — revising a presented plan

A change to plan.html can come from a comment on the page or from the terminal. Handle every
change in this order.

## 1. Check the claim

If the change says a file, function or spec heading exists, open it. Do not edit on an
unchecked claim.

## 2. Ask before a serious change

Serious means: it goes against the spec, an ADR or an approved decision; it drops a test
scenario; it moves work to another phase. For a serious change, say what will happen if it
goes ahead and wait for the answer. Any other change: make it, then report it.

Ask one question per message, in the terminal, never in the comment thread. When you are
unsure, say what you will do by default and let the user say otherwise. Set the thread's
status after the answer comes.

## 3. Make the change in every file it affects

- plan.html and its payload blocks. Never edit `plan.md` or a `phase-N.md` directly; edit its
  block in plan.html, then re-run extraction if that file exists on disk.
- `design.md`, when it exists.
- Every step that uses the changed step's output. The phase's test scenarios. The acceptance
  list. The Design System row. The commit message.
- When it changes a decision an ADR from this run records: delete that ADR and its INDEX.md
  line — it is not committed yet — and run step 7's Record the ADRs again. Then make `## ADRs`
  match what is on disk.
- If the plan now does something different from what the ticket, mock or spec asked, add a
  row to plan.md's `## Design corrections`.

## 4. When the round is done, review once

The round is done when every comment in the batch has a status and every terminal question
has its answer. Run the verifier:

```bash
node --experimental-strip-types <skill-dir>/scripts/verify-plan.ts .harness/<name>/plan.html
```

Then dispatch one fresh-context reviewer. It receives the paths to plan.html, `design.md`
and this run's ADRs, plus the list of what changed — never the session history. Its one
question: are these files in sync with each other and with the change? It returns `PASS`,
or `FAIL` with one line per finding: `<file>: <what disagrees with what>`. On `FAIL`, fix
every finding and dispatch again. Present only on `PASS`. Skip the reviewer in `--auto`.

## 5. Re-present

Write one message to the user with these blocks, in order:

1. **Changed** — one line per change: what changed, why, and the `D<n>` and phases it touched.
2. **Decisions** — the full `D<n>` list as it now stands, one line each. Mark the new and the
   altered ones.
3. **Phases** — one line per phase: title and step count. Mark the ones that changed.
4. **Scenarios** — the total, and what was added, moved or dropped.
5. **Next** — one sentence.

Then `AskUserQuestion`. Its question text repeats the Changed lines, one per line, above the
question, so the reviewer reads them where the choice is made. Header `Approve?`, options
`Approve (Recommended)` / `Revise`.

Do not restart the viewer after an edit; the page in the user's tab updates by itself. Do
not run extraction until the user answers `Approve`. A change made or a comment closed is
not an approval.
