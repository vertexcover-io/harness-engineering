---
name: skill-review
description: Reviews an agent skill against a rubric covering description quality, invocation, structure, integrity, coherence, test coverage, security, content, convention and cost, then writes a report plus machine-readable findings. Use whenever the user asks to review, audit, critique, grade, score or sanity-check a skill or a SKILL.md, whenever a skill has just been written or edited, whenever a skill under-triggers or behaves inconsistently between runs, and before any skill is shared, published or committed — even when the request is only "is this skill any good" or "what's wrong with my skill". This judges a skill as written; skill-creator measures one by running evals against it, and writing-skills helps author a new one from scratch.
---

# Skill review

Review one skill, or every skill in a directory, and report what is wrong with it.

The rubric lives in [references/rubric.md](references/rubric.md). Read it during step 2. It holds
every check, its severity, and the reasoning behind it — that reasoning is what turns a finding
into something the author can act on, so quote it rather than paraphrasing from memory.

## Why two passes

Roughly twenty checks are mechanical: line counts, character limits, third-person phrasing,
backslash paths, nested references, unquoted shell variables. A script answers those in under a
second, identically every time, for zero model tokens.

The rest need a reading. Spend your attention there.

Running the judgment pass over checks the script already answered is the exact waste this skill
exists to find in other skills. Do not do it here.

## Step 1 — deterministic pass

```bash
SKILL="${CLAUDE_PLUGIN_ROOT}/skills/skill-review"
python3 "$SKILL/scripts/check.py" SKILL_PATH
```

Add `--json` when the findings are going into a file or a CI gate. Exit code is 1 if any blocker
fired, 0 otherwise, so it drops straight into a pipeline.

For a directory of skills, loop over each child that contains a `SKILL.md`.

Read the output. Those findings are settled — carry them into the report verbatim and move on.

## Step 2 — judgment pass

Read the skill: `SKILL.md`, every reference file, every bundled script, and the evals if there are
any. Then work [references/rubric.md](references/rubric.md) top to bottom, skipping anything marked
`[script]`.

**This step is done when every judgment check has a verdict — a finding, a pass, or
not-applicable.** Not when you have enough findings to write about. The report format in step 3 is
already visible to you, and a step whose bound is "enough" ends the moment writing starts to feel
more productive than reading. Hold the line until the rubric is exhausted; a check you skipped is
indistinguishable, in the report, from a check that passed.

Two habits decide whether the verdicts are worth anything:

**Verify the claims, do not just read them.** Rubric check I3 carries the full argument and the
positive-control technique — read it there rather than working from memory.

**Quote the evidence.** Every finding carries a file and line, and the text that triggered it. A
finding the author cannot locate is a finding they will not fix.

Rank by whether it can ship broken, not by how easy it is to describe. A security finding or a
false factual claim outranks a naming nit, however many naming nits there are.

## Step 3 — write the report

Findings go in two forms. The markdown is what the author reads; the JSON is what a pipeline gates
on. Write both, and keep them in sync — they are one set of findings in two shapes, not two lists.

Save the JSON beside the skill as `skill-review.json` unless the user names somewhere else. Skills
installed from a plugin live under a read-only cache path, so if that write fails, put it in the
working directory and say where it went — do not drop the findings.

```json
{
  "skill": "my-skill",
  "path": "/abs/path/to/my-skill",
  "findings": [
    {
      "id": "D5",
      "category": "description",
      "finding_type": "description_is_feature_list",
      "severity": "major",
      "deterministic": false,
      "location": "SKILL.md:2",
      "evidence": "description: duplicate-check, scoring, ownership routing",
      "fix": "Lead with a verb and state the condition that should trigger it."
    }
  ]
}
```

`severity` is one of `blocker`, `major`, `minor`, and decides whether CI stops. `deterministic`
records which pass produced the finding. `finding_type` comes from the closed list the rubric
defines — an invented type is a finding nobody can filter, chart or dedupe later, which is why the
list stays closed. Anything genuinely new goes to `out_of_rubric` instead.

Then the report:

```markdown
# <skill-name> — review

**N blockers · N major · N minor** — <one sentence on whether this can ship>

## Blockers
### <ID> <short title>
`<file>:<line>`
> <the offending text>

<what is wrong, why it matters, what to do instead>

## Major
...

## Minor
...

## out_of_rubric
<pattern name> — <what was seen>. Promote to a category if it recurs.

## What is good
<two or three things worth keeping, named specifically>
```

The closing section is not padding. An author who is told only what is broken will rewrite the
parts that were working.

## Fixing

Report first, then ask whether to apply the fixes. Blockers and mechanical findings are usually
safe to apply directly. Anything touching the description, the completion criteria, or the degrees
of freedom changes how the skill behaves at runtime, so those are the author's call — propose the
replacement text and let them choose.

If asked for a score, derive it from severity rather than inventing a scale: any blocker means the
skill is not shippable, and below that, report the counts.

## Reviewing this skill

It passes its own rubric, including the eval minimum and the script test. When editing it, re-run:

```bash
SKILL="${CLAUDE_PLUGIN_ROOT}/skills/skill-review"
python3 "$SKILL/scripts/test_check.py"
python3 "$SKILL/scripts/check.py" "$SKILL"
```

A rubric that exempts itself is not a rubric.
