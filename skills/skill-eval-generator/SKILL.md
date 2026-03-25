---
name: skill-eval-generator
description: >
  Generates eval test suites (evals.json + fixture files) for any skill by analyzing its SKILL.md.
  Use when the user says "generate evals for X", "create tests for X skill", "write evals",
  "eval suite for X", or wants to create test coverage for a skill before running skill-creator eval.
  Also trigger when the user mentions testing skills, validating skill behavior, or creating
  eval fixtures. This skill generates the test definitions — it does not run them.
---

# Skill Eval Generator

Generate a ready-to-run eval suite for any skill by reading its SKILL.md and producing
test cases with realistic prompts, objectively verifiable expectations, anti-expectations,
and fixture files where the skill operates on file inputs.

## Workflow

### Step 1: Read and Analyze the Target Skill

Read the SKILL.md provided by the user. Extract:

- **Name and description** from YAML frontmatter
- **Behavioral rules** — scan for lines containing MUST, MUST NOT, ALWAYS, NEVER,
  DO NOT, and strong imperatives. These become expectations and anti-expectations.
- **Output artifacts** — what does the skill produce? (files, commits, structured output,
  plans, reviews, specs). This tells you what to assert on.
- **Input requirements** — does the skill consume files, diffs, source code, configs?
  This determines whether you need fixture files.
- **Workflow stages** — ordered steps that skill follows. Each stage is a potential
  assertion ("stage X was completed before stage Y").
- **Checklist items** — if the skill has a checklist, each item maps to an expectation.

If the SKILL.md is minimal (few rules, no clear workflow), warn the user:
> "This SKILL.md has few explicit behavioral rules. Generated evals will be shallow.
> Consider enriching the SKILL.md with more specific instructions before generating evals."

### Step 2: Classify Whether Fixtures Are Needed

Determine analytically from the SKILL.md content — not from a lookup table — whether
the skill operates on input files:

- **Fixtures needed** if the skill references reading files, diffs, source code, reviewing
  code, analyzing code, or operating on user-provided documents. Generate source files
  with intentional, realistic flaws tailored to the skill's domain.
- **No fixtures** if the skill operates on prompts, git state, conversation context, or
  orchestrates other skills. Use rich, realistic prompts instead.

### Step 3: Show Analysis Before Generating

Before writing anything, present a brief analysis to the user:

```
Skill: <name>
Type: <code-operating | git-operating | prompt-only | meta/orchestrator | utility>
Eval count: <N> (default 3, or user-specified)
Fixtures needed: <yes/no — with brief reason>
```

Wait for confirmation before proceeding.

### Step 4: Generate Evals

For each eval:

1. **Craft a realistic prompt** — something a real user would type, not a test harness.
   Include enough context to be specific ("Add a login form with email validation" not
   "Test the TDD workflow"). Vary the prompts across evals to exercise different aspects
   of the skill.

2. **Derive expectations** from the behavioral rules extracted in Step 1. Each expectation
   must be objectively verifiable — a grader should be able to check it against actual
   output without subjective judgment. Map rules to specific, observable behaviors:
   - "Runs git status before committing" (checkable in transcript)
   - "Output includes severity levels for each finding" (checkable in output file)
   - "Writes a failing test before implementation code" (checkable in tool call sequence)

3. **Derive anti-expectations** from MUST NOT / NEVER / DO NOT clauses and from common
   failure modes of the skill's domain. Anti-expectations catch dangerous behaviors:
   - "Does not use git add . or git add -A"
   - "Does not write implementation before tests"
   - "Does not skip the RED phase"

4. **Generate fixture files** (only if classified as needed). Each eval gets its own
   dedicated fixtures — no sharing across evals. Fixtures should contain realistic,
   non-obvious flaws calibrated to the skill's domain. A code-review eval needs code
   with subtle bugs (mutable default args, missing await on async calls, race conditions),
   not toy syntax errors.

### Step 5: Write Output Files

Write to `skills/<skill-name>/evals/`:

- `evals.json` — the eval suite
- `files/` — fixture files (only if needed)

If `evals/evals.json` already exists, ask the user using `AskUserQuestion` tool:
- **Overwrite** — replace completely
- **Append** — add new evals, incrementing IDs from the highest existing ID
- **Skip** — leave this skill alone

### Step 6: Print Summary and Next Step

```
Generated <N> evals for <skill-name>
- <X> expectations, <Y> anti-expectations total
- <Z> fixture files created (or "no fixtures needed")

Run evals with: /skill-creator eval skills/<skill-name>/SKILL.md
```

## Output Format

### evals.json Schema

```json
{
  "skill_name": "<skill-name>",
  "evals": [
    {
      "id": 1,
      "name": "descriptive-kebab-case-name",
      "prompt": "Realistic user prompt",
      "expected_output": "Brief description of what good output looks like",
      "files": [],
      "expectations": [
        "Objectively verifiable positive assertion"
      ],
      "anti_expectations": [
        "Thing the skill must NOT do"
      ]
    }
  ]
}
```

**Conventions:**
- `id` starts at 1
- `name` is always included — descriptive kebab-case
- `files[]` uses project-root-relative paths (e.g., `skills/tdd/evals/files/eval1_app.py`)
- `expectations` — 5-8 per eval is the sweet spot; each maps to a specific SKILL.md rule
- `anti_expectations` — 2-4 per eval; focus on the most dangerous failure modes

### Fixture Files

- Location: `skills/<skill-name>/evals/files/`
- Naming: eval ID prefix — `eval1_api.py`, `eval1.diff`, `eval2_component.tsx`
- Each eval's fixtures are independent

## Quality Standards

These are the difference between useful evals and generic ones. Every generated eval
must meet these standards:

**Expectations must be objectively verifiable.** A grader (human or LLM) should be able
to determine pass/fail by checking concrete output — file contents, tool call sequences,
presence of specific sections. Never write "produces good output" or "is well-structured."

**Expectations must trace to specific SKILL.md rules.** Every assertion should correspond
to a documented behavior. If you can't point to the rule it came from, it's generic filler.

**Anti-expectations must cover dangerous failure modes.** Don't just negate expectations.
Think about what would go wrong if the skill misbehaved — skipping verification steps,
using destructive commands, producing output that looks right but misses critical checks.

**Prompts must sound like real users.** "Add a login form with email and password fields"
not "Test scenario: implement user authentication feature using TDD methodology."

**Fixtures must have realistic, non-obvious flaws.** For code-review: mutable default
arguments, missing await on async calls, race conditions on shared state, dropped test
coverage after refactors. Not: missing semicolons or undefined variables.

## Few-Shot Examples

These three patterns show what good evals look like for different skill types.
Use them to calibrate quality, not as rigid templates.

### Pattern 1: Prompt-Only (git-commit style)

For skills that operate on conversation/git context, not input files:

```json
{
  "id": 1,
  "name": "basic-commit-request",
  "prompt": "Commit my changes",
  "expected_output": "Multiple logical commits with conventional messages, plan presented before executing",
  "files": [],
  "expectations": [
    "Runs git status and git diff before proposing any commits",
    "Checks git log for existing commit message conventions",
    "Groups test file changes with their corresponding implementation file changes",
    "Presents a commit plan to the user before executing any git commit commands",
    "Uses conventional commit prefixes (feat, fix, refactor, test, chore, etc.)"
  ],
  "anti_expectations": [
    "Does not use git add . or git add -A",
    "Does not run git reset HEAD"
  ]
}
```

Notice: expectations map directly to git-commit SKILL.md rules. Each is checkable
in the transcript or output.

### Pattern 2: Fixture-Heavy (code-review style)

For skills that analyze input files — create source files with planted bugs:

```json
{
  "id": 1,
  "name": "python-api-bugs",
  "prompt": "Review this Python API code for bugs. The diff is at skills/code-review/evals/files/eval1.diff and the full source is at skills/code-review/evals/files/eval1_api.py.",
  "expected_output": "A REVIEW.md identifying mutable default argument, bare except, thread-safety issue, missing KeyError handling, and naive datetime",
  "files": ["skills/code-review/evals/files/eval1.diff", "skills/code-review/evals/files/eval1_api.py"],
  "expectations": [
    "Review identifies mutable default argument bug in validate_email (allowed_domains=[])",
    "Review identifies except Exception as overly broad",
    "Review identifies thread-safety or race condition on _users dict",
    "Review output has severity levels (Critical/Important/Minor or equivalent)",
    "Every defect finding includes a file:line reference"
  ],
  "anti_expectations": [
    "Does not flag style issues, formatting, or naming conventions",
    "Does not produce false positives on correct code patterns"
  ]
}
```

Notice: expectations name the exact bugs planted in the fixture. The fixture file
would contain Python code with those specific flaws.

### Pattern 3: Integration (orchestrate style)

For multi-stage pipeline skills — assert on stage completion and artifacts:

```json
{
  "id": 1,
  "name": "timeout-config",
  "prompt": "Add a configurable per-request timeout to generate_video, generate_image, and generate_audio.",
  "expected_output": "Modified config models, updated handlers, tests, spec/plan docs, PR created",
  "files": [],
  "expectations": [
    "All 8 pipeline stages (setup through commit) were attempted",
    "A spec document was created in docs/spec/ with testable acceptance criteria",
    "A plan document with phases was created",
    "All unit tests pass",
    "New tests written for the feature",
    "Changes committed with meaningful messages"
  ],
  "anti_expectations": [
    "Does not skip the brainstorm or planning stages",
    "Does not commit without running tests first"
  ]
}
```

Notice: expectations verify pipeline completeness and artifact creation, not
implementation details.

## Input

The user provides a path to a SKILL.md file, and optionally an eval count:

- `/skill-eval-generator skills/tdd/SKILL.md`
- `"Generate evals for the tdd skill"`
- `"Create a test suite for code-review with 5 test cases"`
- `"Write evals for the orchestrate skill"`

Default eval count is 3 unless the user specifies otherwise.
