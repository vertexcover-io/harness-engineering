# Making a change — revising a presented plan

### Step 1: Understand the requested change

Establish what the user wants to change in the plan and what outcome they expect. Read the
relevant parts of plan.html and the source documents needed to understand the request.

Do not edit any files yet.

### Step 2: Trace what the change affects

Find every existing decision and plan region directly affected by the requested change.
Check plan.html, `design.md`, this run's ADRs and any other source file used by the plan.

Follow the impact through dependent decisions and steps. A change to one decision may affect
another decision, a phase, its test scenarios, the acceptance list, the Design System row,
an ADR or a commit message.

Read the full `D<n>` decision list. Do not stop after finding the first affected decision.

### Step 3: Decide how to handle each impact

For every affected item, decide whether it must change to keep the plan and its source files
consistent.

- If only one reasonable change follows from the user's request, record it for step 4. Do
  not interrupt the user. Include it in the change summary later.
- If more than one workable solution exists, or the correct change is not obvious, ask the
  user to decide. Explain the options and recommend one.
- Ask one question per message, in the terminal, never in the comment thread. Set the
  thread's status after the answer comes.

A user's answer may affect more decisions or files. Trace those new impacts and repeat this
phase until every required change is known and no question remains unresolved.

### Step 4: Make the settled changes

Once every comment has a status and every question has an answer, make all agreed and
required changes.

Update every affected source:

- plan.html and its payload blocks.
- `design.md`, when it exists.
- This run's ADRs and their `INDEX.md` entries.
- Every affected `D<n>` decision, phase step, test scenario, acceptance item, Design System
  row and commit message.
- Any other source file that must change to keep the plan coherent.

Never edit `plan.md` or a `phase-N.md` directly. The extraction script derives those files
from plan.html after the user approves the plan and the final review passes.

When a changed decision invalidates an ADR from this run, delete that ADR and its `INDEX.md`
entry, run the planning flow's Record the ADRs step again, and make plan.html's `## ADRs`
section match the files on disk.

If the plan now differs from the ticket, mock or spec, record the difference in the plan's
`## Design corrections` payload block.

### Step 5: Verify the edited plan

Run:

```bash
node --experimental-strip-types <skill-dir>/scripts/verify-plan.ts .harness/<name>/plan.html
```

Fix every verifier failure before presenting the revised plan.

### Step 6: Summarize and ask for approval

Briefly summarize all changes made to the plan and its related files, including required
changes that did not need a user decision.

Then ask the user to approve the revised plan or request another change.

If the user requests another change, return to step 1. Do not treat a closed comment or an
applied edit as approval.

### Step 7: Run the final consistency review

After the user approves the revised plan, dispatch one fresh-context reviewer. Give it only
the paths to plan.html, `design.md`, this run's ADRs and every other source file involved in
the plan. Do not pass the session history.

Ask it whether the files agree with one another and form one coherent plan. It must return
one of:

- `PASS`
- `FAIL`, followed by one line per finding:
  `<file>: <what conflicts with, contradicts or is unclear in another file>`

On `FAIL`, present every finding to the user. If resolving a finding requires a decision,
return to step 1. After making any resulting changes, verify the plan, summarize it and ask
for approval again before dispatching another fresh-context reviewer.

Skip the reviewer in `--auto`. After the reviewer returns `PASS`, or after verification in
`--auto`, run the extraction script to sync `plan.md` and every `phase-N.md` with plan.html:

```bash
node <skill-dir>/scripts/extract-plan.mjs .harness/<name>/plan.html
```

Then continue to the next planning stage.

Do not restart the viewer after an edit. The page in the user's tab updates by itself.
