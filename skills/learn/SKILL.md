---
name: learn
description: "Capture learnings from the current conversation as a clean, human-readable doc in docs/. Use after solving a non-trivial problem, discovering a design pattern, hitting a gotcha, or making an architectural decision worth remembering. Triggers on: 'document this', 'capture this learning', 'that was tricky', 'let's compound this', or /learn."
argument-hint: "[optional: brief context about what to capture]"
allowed-tools: Bash, Read, Edit, Write, Task, Grep, Glob
user-invocable: false
---

# /learn — Capture What You Learned

Write a single, clean markdown doc that captures what this conversation figured out — the principle, the gotcha, the pattern, or the fix. No slop, no filler. Every paragraph earns its place.

## What this captures

Two kinds of knowledge, often in the same doc:

1. **Meta-level**: Design principles, architectural decisions, philosophy — the "why" that applies beyond this specific instance
2. **Gotchas**: Concrete traps, error messages, things that broke and how to fix them — the "what" that saves 30 minutes next time

Good docs have both. A design pattern doc should include the concrete code. A bug fix doc should explain the principle it violated.

## When to use

- After solving a non-trivial problem
- After discovering a pattern worth reusing
- After making an architectural decision with trade-offs
- After hitting a gotcha that would bite someone else
- After a debugging session that revealed something non-obvious

Skip it for: typos, trivial config, obvious one-liners.

## Context hint

<context_hint> #$ARGUMENTS </context_hint>

If the context hint above is empty, scan the conversation for the most significant learning — usually the thing that took the most investigation or had the most non-obvious outcome.

## Process

### Step 1: Extract the learning

Reflect directly on the conversation. Do NOT spawn a sub-agent.
Extract the following from memory:

### Step 2: Check for existing related docs

Search `docs/` for similar topics:

```bash
Grep: pattern="<keywords from extracted tags>" path=docs/ output_mode=files_with_matches -i=true
```

If a closely related doc exists, decide:
- **Same topic, new angle**: Create new doc with cross-reference
- **Same topic, same angle**: Update existing doc instead of creating new one
- **Tangentially related**: Create new doc, add to Related section

### Step 3: Determine the file path

**Category directories** (mapped from the extracted category):

| Category | Directory |
|----------|-----------|
| design-patterns | `.harness/knowledge/lessons/design-patterns/` |
| gotchas | `.harness/knowledge/lessons/gotchas/` |
| debugging | `.harness/knowledge/lessons/debugging/` |
| architecture | `.harness/knowledge/lessons/architecture/` |
| performance | `.harness/knowledge/lessons/performance-issues/` |
| integration | `.harness/knowledge/lessons/integration-issues/` |
| workflow | `.harness/knowledge/lessons/workflow-issues/` |
| tooling | `.harness/knowledge/lessons/tooling/` |

**Filename**: `<slugified-title>-<YYYYMMDD>.md` if the title is unique enough, or `<slug>-<component>-<YYYYMMDD>.md` if disambiguation helps.

Examples:
- `flex-column-pinning-modal-footers-20260224.md`
- `cost-estimation-token-extraction-all-harnesses.md`
- `cascading-fetch-usecallback-searchparams-taskit-frontend-20260220.md`

### Step 4: Decide scope — task-specific or globally reusable?

Two destinations. Most learnings go to *one* of them; rarely both.

- **Task-specific** — gotchas, decisions, or context that only matter for understanding *this* PR. Write to `.harness/features/<SPEC_NAME>/learnings.md` (committed, lives next to the spec it pertains to). If invoked outside the orchestrate pipeline (no `SPEC_NAME` available), skip this destination.
- **Globally reusable** — patterns, gotchas, or architectural insights that future work on *any* feature should benefit from. Write to `.harness/knowledge/lessons/<category>/<filename>.md` (committed — lessons travel with the PR and compound across the team; see `../_shared/knowledge.md`).

Ask: "Would a developer working on an unrelated feature 6 months from now benefit from this?" → if yes, global. If it only makes sense in the context of this spec → task-specific.

If both apply, write the global doc and add a short pointer from `.harness/features/<SPEC_NAME>/learnings.md` referencing it.

### Step 5: Write the doc

Create a single markdown file using the template below. Populate it from the subagent's extracted material. The main conversation writes the file — no subagent writes files.

For **task-specific**: append to `.harness/features/<SPEC_NAME>/learnings.md` (create on first learning; subsequent learnings append as new sections).

For **globally reusable**:

```bash
mkdir -p .harness/knowledge/lessons/<category>/
```

Then write the file.

## Document template

```markdown
---
title: "<specific descriptive title>"
date: <YYYY-MM-DD>
category: <category>
tags: [<tag1>, <tag2>, <tag3>]
component: <component>
severity: <low|medium|high|critical OR design>
status: <implemented|documented|observed>
applies_to: ["<glob1>", "<glob2>"]
stage: [<plan|code|review|verify>]
evidence_count: 1
last_validated: <YYYY-MM-DD>
source: <signal>@<spec>
related: ["<path/to/related/file>"]
---

# <Title>

## Problem

[What happened. Concrete: error messages, symptoms, the situation that led here. 2-4 sentences max.]

## Insight

[The core learning. This is the section people will re-read. Could be:]
[- A design principle with rationale]
[- A pattern with when/why to use it]
[- A root cause explanation]
[- An architectural trade-off analysis]

[If there's a principle, state it as a single bold sentence first, then explain.]

## Solution

[What was done. Code examples with file paths. Before/after if applicable.]

```<language>
# file: path/to/file.ext
<code>
```

## Prevention / Reuse

[How to apply this going forward. Concrete checklist or rules, not vague advice.]

- [Specific thing to do or check]
- [Pattern to follow]
- [Signal that this problem is recurring]

## Related

- [Link to related doc or file]
```

### Routing fields (how lessons get retrieved)

The `applies_to` / `tags` / `stage` / `evidence_count` / `last_validated` / `related`
fields drive deterministic retrieval — full semantics in `../_shared/knowledge.md`
(do not restate them here). Two rules that matter while writing:

- **Inline-list syntax is required** (`tags: [a, b]`, `applies_to: ["src/api/**"]`) —
  multi-line YAML lists parse as absent and the lesson degrades to tag-only routing.
- `applies_to` globs should be as narrow as the lesson truly is; a glob matching most
  of the repo gets demoted to tag-only rank at route time. Omit `source` for manual
  `/learn` captures (the curator sets it).

### Adapting the template

Not every doc needs every section. Use judgment:

- **Design pattern docs**: Emphasize Insight + Solution with code. Problem can be brief.
- **Gotcha/debugging docs**: Emphasize Problem (exact errors) + Solution (exact fix). Insight explains why.
- **Architecture docs**: Emphasize Insight (trade-offs) + Prevention (decision criteria). Code may be minimal.
- **Performance docs**: Emphasize Problem (metrics) + Solution (before/after benchmarks).

If a section would be empty or forced, skip it. A 3-section doc that's all signal beats a 6-section doc with filler.

### Step 6: Reindex

After writing any globally reusable lesson, regenerate the knowledge index so the new
lesson becomes routable (invocation contract: `../_shared/knowledge.md`):

```bash
node "<plugin-root>/skills/_shared/knowledge.mjs" reindex
```

Script failure → note `knowledge skipped — <reason>` and continue (never block the
capture). Critical lessons need no CLAUDE.md entry: the SessionStart hook injects the
INDEX every session, and CLAUDE.md carries exactly one learning-loop pointer line.

### Step 7: Present result

After writing the file, show the user:

```
Done — <path-written>  (e.g. .harness/features/<SPEC_NAME>/learnings.md, or .harness/knowledge/lessons/<category>/<filename>.md)

<2-sentence summary of what was captured>

Next:
1. View the doc
2. Cross-reference with another doc
3. Continue working
```

## Quality bar

Every doc should pass this test: **If someone reads only this doc 3 months from now, can they understand the problem, apply the solution, and know when it's relevant — without reading anything else?**

Signals of a good doc:
- Title tells you what it's about without opening it
- First paragraph of Problem gives you the "should I keep reading?" signal
- Insight section is quotable — you could paste it in a PR review
- Code examples are copy-pasteable
- Tags are searchable — someone grepping `.harness/knowledge/lessons/` for "n-plus-one" or "flex-column" finds it

Signals of a bad doc:
- Generic title ("Fixed a bug", "Updated the code")
- Insight is just "we fixed it by changing X" (that's a Solution, not an Insight)
- No code examples for a code-related learning
- Filler phrases ("It's worth noting that...", "This approach ensures...")
- Prevention section says "be careful" instead of giving concrete checks