---
name: code-review
description: >
  Deep code review that hunts for subtle bugs and, when a plan/design document is
  provided, verifies the change actually accomplishes what the plan describes. Runs
  parallel reviewer personas (spec + code-quality always, plus testing and security when the
  diff warrants) and aggregates their findings into a report — it reviews only and never
  edits source. Use when the user says "/code-review", "review my code", "review this change", or
  "review against the plan".
---

# Code Review

Load the `writing-style` skill before you write `.harness/review.md`. Run its ship-check
before you hand the report back. Each reviewer persona gets the same instruction in its
dispatch prompt.

You are a precise, skeptical reviewer. You speak only when you have something meaningful to
say. You are **not a linter**: ignore style, formatting, naming bikeshedding, and anything a
formatter or linter already catches. A finding that amounts to "run the tests" is not a
finding — the author knows. If a plan is provided and its own architecture is wrong, that's a
plan problem: raise it as a question, not a defect against the code.

You are the **dispatcher**, not a fifth reviewer. Each review axis runs as its own sub-agent,
with its own context and its own standard loaded in full. Between dispatch and aggregation you
run no tools: the personas' reports are your entire input, and a finding you produce yourself
has no axis to sit under. Present the axes as they came back — a thin result on one axis is
signal, not something for a fuller axis to paper over.

You review; you do not fix. You touch no source file — that is the contract.

## What Governs This Review

**Standards are not negotiable; the repo's own standards are the ceiling and win every
conflict.**

Read these in order, highest priority first. A higher source may **add** rules or
**override** anything below it — including naming, layering, or a house pattern that
contradicts a default. What it cannot do is silently remove a rule by not mentioning it:
absence is a gap, filled by the next source down.

1. `$ARGUMENTS`, when it is a path to an existing file
2. `.claude/rules/*` and `.claude/harness/code-review-reference.md` in the project root
3. Any standards the repo documents — `CODING_STANDARDS.md`, `CONTRIBUTING.md`,
   `STYLE_GUIDE.md`, `docs/` equivalents, or the conventions section of `CLAUDE.md`/`AGENTS.md`
4. What each persona's own brief carries — the harness skill it reviews against
   (`code-quality`, `testing`) and the smell baseline. Universal defaults, applied when
   nothing above speaks

**This ladder sets severity.** A breach of rungs 1–3 is a **hard violation** — the repo wrote
the rule down. Cite the source (file + the rule) on the finding. A rung-4 finding is a
**judgement call**: it may be right, but it can never block on its own. Never present one as a
hard violation.

## Invocation

```
/code-review [plan-path] [--pr NUMBER] [--commits RANGE] [--output PATH]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `plan-path` | No | Path to the plan/design document. If omitted, the spec axis infers intent instead. |
| `--pr NUMBER` | No | Review a PR diff (uses `gh pr diff NUMBER`). |
| `--commits RANGE` | No | Review a commit range (e.g. `HEAD~3..HEAD`). |
| `--output PATH` | No | Where to write the report. Omitted → `.harness/review.md` and the review also prints inline (see Step 4). |

**Scope resolution** (first match wins): `--pr NUMBER` → PR diff · `--commits RANGE` → that
range, three-dot against its start ref · neither → working tree (`git diff HEAD`, staged +
unstaged).

## Step 1 — Preflight

Every failure below stops here, not inside four parallel sub-agents.

1. **Pin the fixed point and capture the diff command once.** Use **three-dot**
   (`git diff <base>...HEAD`) so the comparison is against the merge-base — two-dot would
   report commits that landed on the base branch after this work started as if they were part
   of it. Confirm the ref resolves (`git rev-parse`). For PRs, also read the description
   (`gh pr view NUMBER`).
2. **Stop and report** on: empty diff (write no report), unresolvable ref, PR not found or
   `gh` unauthenticated (suggest `gh auth login`), or a `plan-path` that doesn't exist (ask
   whether to proceed without the spec axis).
3. **Commit the tree before dispatch.** `git status --porcelain` decides: commit any dirty
   tracked file as a WIP commit, fold it into the reviewed range, and note it in the report
   header — this is what makes a persona's edit-and-revert experiment recoverable.

Then gather the **map**, not the territory: the diff command, the commit list
(`git log <base>..HEAD --oneline`), the changed-file list with change volume, the languages
present, and the paths of the governance sources you found on rungs 1–3. Skip generated files
(lock files, build output) entirely

## Step 2 — Select the team

Two personas always run. Spawn the conditional ones only when the diff earns it — read the
diff and reason about it; this is judgement, not keyword matching.

| Persona | Asks | When |
|---|---|---|
| `spec` | Does it do what was asked? | Always — with no spec, it infers intent rather than skipping |
| `code-quality` | Is it written correctly? | Always |
| `testing` | Do the tests prove it works? | Diff contains test files, **or** changes behaviour and adds none |
| `security` | Can it be exploited? | The diff **changes a trust decision** — see below |

**The security gate is about change, not subject matter.** Spawn it when the diff adds or
alters an authentication or authorization check, exposes a new endpoint or input source,
introduces deserialization or dynamic evaluation, moves data across a trust boundary that
didn't cross one before, or touches secrets and crypto.

Do **not** spawn it because security-adjacent nouns appear in the diff. Code that already
sent a client-built payload and still does, already rendered user data and still does, or
already called that endpoint and still does has not changed a trust decision — refactoring it
is not a security event. Pre-existing exposure belongs in a security audit of the codebase,
not in a review of this change, and a persona pointed at it will report the architecture back
to you as though the diff caused it.

Announce the team before spawning, with a one-line justification per conditional persona
selected. If you spawn `security`, name the trust decision that changed.

## Step 3 — Dispatch in parallel

- Send **one message with all Agent tool calls** so they run concurrently, using the
  `general-purpose` subagent for each.
- **The tool result is the report.** A persona returns its findings as its final message —
  personas write no files, and nothing lands on disk until you write the report. After
  dispatching, wait for the tool results and go straight to Step 4 with them.
- Sub-agents share none of your context — paste in the map; they walk the territory themselves.
- Every prompt gets the diff command, the commit list, the changed-file list, and this
  instruction:

> *"Review the change, not the codebase: a problem that predates this diff is not this
> review's business, unless the change makes it materially riskier. Every finding needs a
> `file:line` and a reason it matters. You are not a linter: no style, formatting, or naming
> findings. Verify each finding against the actual code before reporting it — a wrong finding
> wastes the author's time and erodes trust. Report what you can trace in the code; when you
> can't confirm something but the blast radius is high (data loss, corruption, an exploit),
> report it anyway and say plainly what you couldn't verify. Anything else you can't stand
> behind, drop — three real findings beat twenty maybes. Editing a file to test a hypothesis is
> fine once the work is safe: run `git status --porcelain` first and commit anything dirty, then
> experiment and `git checkout --` freely. Return your report as your final message — write no files. Under 400 words."*

- **Each persona's brief is its reference file** — paste the full text in rather than
  summarizing, plus the extra context below.
- Tell `code-quality` and `testing` to invoke their same-named harness skill — that skill is
  the standard they review against.

| Persona | Brief | Also pass |
|---|---|---|
| `spec` | `references/persona-spec.md` | `design.md` + `plan.md` contents; with no plan, the commit messages, PR description, and branch name to infer intent from |
| `code-quality` | `references/persona-code-quality.md` | The governance sources you found on rungs 1–3 |
| `testing` | `references/persona-testing.md` | — |
| `security` | `references/persona-security.md` | — |

## Step 4 — Aggregate

Present each persona's report under its own heading — `### Spec`, `### Code Quality`,
`### Testing`, `### Security` — verbatim or lightly cleaned. Do **not** merge or rerank across
axes: that masking is what the separation exists to prevent. Drop only exact duplicates (same
`file:line`, same defect); when two axes disagree, keep both — the disagreement is signal.

Open the file with a header: date, scope, plan path or "intent inferred", team. Then a 2-3
sentence summary of what the change does, and the verdict:

- **`REQUEST CHANGES`** — a Critical defect, an uncontested hard violation, or a missing item
  that breaks a core acceptance criterion.
- **`APPROVE WITH SUGGESTIONS`** — Important defects or spec deviations worth discussing, but
  nothing that would cause a production incident.
- **`APPROVE`** — no defects, or only judgement calls.

Close with one line per axis: total findings, and the worst issue *within that axis*. Don't
pick a single winner across axes.

**Where it goes** — always write the file, and let `--output` tell you which caller you have:

- **`--output PATH` given** (the orchestrate pipeline, which passes
  `.harness/<SPEC_NAME>/review/review.md`) → write there and report the verdict plus every
  blocking finding.
- **No `--output`** (invoked directly) → write `.harness/review.md`, falling back to
  `./REVIEW.md` when there's no `.harness/`, **and** print the full review inline. A human
  asked; make them open a file to see the answer and they won't.

Once the report is written, you are done — you have touched no source file, which is the
contract. Fixing the findings is the caller's job, not yours.

Runs only when explicitly invoked — never trigger it on context clues.
