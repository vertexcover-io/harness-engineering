# Blast Radius

Which of the feature's proven behaviours the fix could have broken. Verification re-proves those.

## Trace it

**Dispatch one general-purpose subagent.** The trace reads phase files, plan sections, and a prior
report; what comes back is a list of ids. Give it these four steps and the two spec dirs:

1. **Changed files** — `git diff <PRE_REWORK_SHA>..HEAD --name-only`.
2. **Files → phases** — grep the original run's `phases/phase-*.md` for each changed path. A phase
   whose `## Implementation` names the file owns it.
3. **Phases → scenarios** — those phases' `## Test Scenarios` ids (`S<n>`).
4. **Scenarios → coverage** — the ids in the original `verification/proof-report.html` `coverage[]`
   that those scenarios prove.

**Fail open.** A changed file that lands in no phase widens the radius to every `coverage[]` id in
the prior report. Narrowing is what you have to earn.

**Return two lists**, together accounting for every id in the prior report:

- **In radius** — each id kept, with its requirement text from the original `plan.md`, so the id
  travels with what it means.
- **Out of radius** — each remaining id and the reason it is out.

## Where it goes

- **Into the Stage 5 dispatch** — the in-radius list is the requirement enumeration verification
  runs against, and it reaches that sub-agent only through the prompt.
- **Into the report** — the out-of-radius list only, as a caveat, and only when it is not empty.
