---
name: code-review
description: >
  Deep code review that hunts for subtle bugs and for code that works but should have been
  written differently. Runs eight reviewer personas in parallel, aggregates their findings
  into a report, then applies the fixes and records them in it. Runs as the pipeline's
  code-review stage, after implement; also use it when the user says "/code-review", "review my
  code", "review this change", or "review this against the plan".
mode: inline
allowed-tools: [Agent, Bash, Read, Write, Edit, Grep, Glob, Skill]
tier: deep
consumes:
  - artifact: plan
    optional: true
  - artifact: design
    optional: true
produces:
  - artifact: review
protocols: []
scopes: []
references:
  defects:
    path: references/persona-defects.md
    description: Finds bugs such as wrong logic, unhandled cases and broken error paths.
  spec:
    path: references/persona-spec.md
    description: Checks the change does what the plan and design asked.
  security:
    path: references/persona-security.md
    description: Finds inputs, endpoints and trust decisions an attacker can abuse.
  testing:
    path: references/persona-testing.md
    description: Checks the tests prove the behavior, at the right level.
  reuse:
    path: references/persona-reuse.md
    description: Finds code that rebuilds something the repo already has.
  simplification:
    path: references/persona-simplification.md
    description: Finds code that could say the same thing with less.
  efficiency:
    path: references/persona-efficiency.md
    description: Finds wasted work on a path that matters.
  altitude:
    path: references/persona-altitude.md
    description: Finds code sitting at the wrong layer or level of abstraction.
---

# Code Review

Load the `writing-style` skill before you write the report. Run its ship-check before you hand
the report back. Each reviewer persona gets the same instruction in its
dispatch prompt.

You are the **dispatcher**, not a reviewer. Between dispatch and aggregation you run no tools:
the personas' reports are your entire input, and a finding you produce yourself has no axis to
sit under. Present the axes as they came back — a thin result on one axis is signal, not
something for a fuller axis to paper over.

**This runs unattended — ask the user nothing.** Every call is yours: make it, and record
the assumption in the report.

You have two jobs in order: review, then repair. The report comes first and records what the
review found; the repair follows in Step 4 and is part of the work, not an offer.

## What Governs This Review

**Standards are not negotiable; the repo's own standards are the ceiling and win every
conflict.**

Read these in order, highest priority first. A higher source may **add** rules or
**override** anything below it — including naming, layering, or a house pattern that
contradicts a default. What it cannot do is silently remove a rule by not mentioning it:
absence is a gap, filled by the next source down.

1. The input's `standards`, or `$ARGUMENTS` standalone, when it is a path to an existing file
2. `.claude/rules/*` and `.claude/harness/code-review-reference.md` in the project root
3. Any standards the repo documents — `CODING_STANDARDS.md`, `CONTRIBUTING.md`,
   `STYLE_GUIDE.md`, `docs/` equivalents, or the conventions section of `CLAUDE.md`/`AGENTS.md`
4. The `references/persona-*.md` file each agent is given, and the `code-quality` and `tdd`
   skills those files name. Universal defaults, applied when nothing above speaks

**This ladder sets severity.** A breach of rungs 1–3 is a **hard violation** — the repo wrote
the rule down. A rung-4 finding is a **judgement call**: it may be right, but it can never
block on its own.

## Input

In a run, the input may hold these fields. RUN is the run's spec name. Standalone, the same
names are flags: `/code-review [--plan PATH] [--pr NUMBER] [--commits RANGE] [--output PATH]`.

| Field | Meaning |
|---|---|
| `workspace` | the create-workspace stage's output. Review inside each repo's `worktreeDir`; without it, the current checkout. |
| `plan` | the plan or design doc the change was written from, for the Spec agent. In a run it defaults to `.harness/RUN/artifacts/plan.md`, with `design.md` beside it. With neither, the Spec agent infers intent from the commits, PR description and branch name. |
| `pr` | review a PR diff (`gh pr diff NUMBER`). |
| `commits` | review a commit range, such as `HEAD~3..HEAD`. |
| `output` | where to write the report. In a run it is always `.harness/RUN/artifacts/review.md`. |

**Scope** (first match wins): `pr` → the PR diff · `commits` → that range, three-dot against its
start ref · in a run → the run's branch against its merge-base with the base branch · none →
the working tree (`git diff HEAD`, staged and unstaged).

## Step 1 — Preflight

Every failure below stops here, not inside the sub-agent fan-out.

1. **Pin the fixed point and capture the diff command once.** Use **three-dot**
   (`git diff <base>...HEAD`) so the comparison is against the merge-base — two-dot would
   report commits that landed on the base branch after this work started as if they were part
   of it. Confirm the ref resolves (`git rev-parse`). For PRs, also read the description
   (`gh pr view NUMBER`).
2. **Stop and report** on: empty diff (write no report), unresolvable ref, PR not found or
   `gh` unauthenticated (suggest `gh auth login`), a `plan` path that doesn't exist, or —
   under `pr` — `git rev-parse HEAD` not matching the PR's `headRefOid` (name both SHAs). In a
   run, finish the stage with `--error -` and that reason.
3. **Commit the tree before dispatch.** `git status --porcelain` decides: commit any dirty
   tracked file as a WIP commit, fold it into the reviewed range, and note it in the report
   header — this is what makes a persona's edit-and-revert experiment recoverable.

Then gather the **map**, not the territory: the diff command, the commit list
(`git log <base>..HEAD --oneline`), the changed-file list with change volume, the languages
present, and the paths of the governance sources you found on rungs 1–3. Skip generated files
(lock files, build output) entirely

## Step 2 — Dispatch in parallel

Each axis has one persona reference. Spawn **one `general-purpose` sub-agent per axis, eight in
a single message** so they run concurrently. One agent holding every axis at once matches
shallowly across all of them.

| Agent | Reference | Also give it |
|---|---|---|
| Defects | `defects` | — |
| Spec | `spec` | the full text of the plan and `design.md`, when they exist |
| Security | `security` | — |
| Testing | `testing` | — |
| Reuse | `reuse` | — |
| Simplification | `simplification` | — |
| Efficiency | `efficiency` | — |
| Altitude | `altitude` | — |

Get each persona file's path with `bun run --silent orchestrate skill ref --path
code-review.NAME`, which honors a project's replacement. Outside a run, the files are this
skill's `references/persona-NAME.md`.

**All eight run on every review.** There is no gate and no team selection: an axis with nothing
to report returns nothing, and that emptiness is a result you present.

Every prompt names that agent's persona file by path and tells it to read the file first, before
anything else. Give each agent its own file and no other, so the only axis it can report under
is its own. Tell the Defects, Reuse, Simplification, Efficiency and Altitude agents to also
invoke the `code-quality` skill: it is the standard those five check against.

Then paste in, as text: the map from Step 1, the governance sources you found on rungs 1–3, and
the brief below. A sub-agent shares none of your context, so a summary of a governance source
leaves that standard out of the review.

**One diff, one review, eight agents.** A change spanning several packages or several repos is
still one change. Give every agent the whole diff and treat the working set as a single tree.

> *"You own exactly one review axis — the persona file named for you — and report only under it;
> a real problem outside it belongs to another agent, even when you see it. Review the change,
> not the codebase: a problem that predates this diff is not this review's business unless the
> change makes it materially riskier. Every finding names the thing, quotes the hunk, gives a
> `file:line`, says what it costs, and names the fix. Verify it against the actual code first,
> and drop anything you can't stand behind — three real findings beat twenty maybes. You are not
> a linter: no style or formatting findings, no naming findings beyond a name that misleads
> about what the code does, and nothing that amounts to 'run the tests' — the author knows. A
> finding is a judgement call unless the repo wrote the rule down, which makes it a hard
> violation — cite the source file and rule when it did. The tree was committed before you were
> dispatched, so edit freely to test a hypothesis and `git checkout --` when you're done. Return
> your report as your final message — write no files. Under 400 words."*

**The tool result is the report.** Nothing lands on disk until you write it — wait for all
eight results and go straight to Step 3 with them.

## Step 3 — Aggregate

Present each persona's report under a heading named for its axis — `### Defects`,
`### Spec`, `### Security`, `### Testing`, `### Reuse`, `### Simplification`, `### Efficiency`,
`### Altitude` — verbatim or lightly cleaned. Do **not** merge or rerank across axes: that
masking is what the separation exists to prevent. Drop only exact duplicates (same
`file:line`, same finding); when two axes disagree, keep both — the disagreement is signal.

Reuse, Simplification, Efficiency and Altitude are the exception, because they overlap by
design — a duplicated block is a Reuse finding and a Simplification finding both. Across those
four only, keep one copy per mechanism under the axis that names the fix best.

Open the file with a header: date, scope, and the plan path or "intent inferred". Then
a 2-3 sentence summary of what the change does, and the verdict:

- **`REQUEST CHANGES`** — a Critical defect, an uncontested hard violation, or a missing item
  that breaks a core acceptance criterion.
- **`APPROVE WITH SUGGESTIONS`** — Important defects worth discussing, but nothing that would
  cause a production incident.
- **`APPROVE`** — no defects, or only judgement calls.

Those four axes must not turn an `APPROVE` into `REQUEST CHANGES` between them — volume on
rung 4 is still rung 4.

Close with one line per axis: total findings, and the worst issue *within that axis*. Don't
pick a single winner across axes.

**Where it goes** — always write the file:

- **In a run** → `.harness/RUN/artifacts/review.md`.
- **Standalone with `--output PATH`** → write there and report the verdict plus every blocking
  finding.
- **Standalone without it** → write `.harness/review.md`, falling back to `./REVIEW.md` when
  there's no `.harness/`, **and** print the full review inline. A human asked; make them open a
  file to see the answer and they won't.

## Step 4 — Apply the fixes

**Fix every finding.** Begin editing straight away — a fix that changes what the code does is
still yours to make: the review found it, so repair it. Work sequentially and yourself — the
personas ran in parallel on partial context and edit nothing, so turning them loose on one
tree would collide.

Commit each repair on its own as you go, and record it in the report under a **Fixes applied**
heading: `file:line`, what changed, and why. Add to the report; the findings above stay as
written.

Run the repo's typecheck, lint, and tests once, after the last edit. If they fail, revert the
repair commits newest-first until they pass, and record each reverted one under **Left
unfixed** with the failure it caused.

**You are done when every finding sits under Fixes applied or Left unfixed** — walk the report
axis by axis and account for each one, then restate the verdict. `REQUEST CHANGES` still stands
when a blocking finding is one you left.

## Finish

In a run, finish the stage with `--artifact review=artifacts/review.md`. The output is the final
verdict on its first line, then one line per finding left unfixed.

Standalone, this skill runs only when explicitly invoked — never trigger it on context clues.
