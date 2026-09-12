# The rubric

## Contents

- [Gate 0 — the two tests](#gate-0--the-two-tests)
- [1. Description](#1-description)
- [2. Structural discipline](#2-structural-discipline)
- [3. Integrity](#3-integrity)
- [4. Test coverage](#4-test-coverage)
- [5. Security](#5-security)
- [6. Content quality](#6-content-quality)
- [7. Convention](#7-convention)
- [8. Cost and determinism](#8-cost-and-determinism)
- [9. out_of_rubric](#9-out_of_rubric)
- [Sources](#sources)

Severity: **blocker** stops a merge · **major** should be fixed before sharing · **minor** is polish.

`[script]` means `scripts/check.py` already reported it — read its output, do not redo the work.
`[judgment]` means only a reading of the skill can decide it. Those are the ones worth your tokens.

Everything here reduces to one idea: **a skill exists to wrangle determinism out of a stochastic
system.** Predictability means the agent takes the same *process* every run, not that it produces
the same output. Every check below marks a place where a dice roll can hide.

---

## Gate 0 — the two tests

Run these against every section before anything else. Most real findings come from here.

**The deletion test.** *Would deleting it really change what the model does?*

**The no-op test.** Does this line change behaviour **versus the default**? This is model-relative,
not reader-relative: two reviewers disagreeing about a no-op are disagreeing about the default, and
the way to settle it is to run the skill, not to argue. When a sentence fails, delete the whole
sentence rather than trimming words from it.

The most common flaw in real skills is teaching the model to perform actions it already knows how
to perform.

> Bad: "Open the tool, find deploy, check stages, review rollbacks."
> Good: "`asset-compile` usually bottlenecks at 15-20 minutes. Longer suggests OOM kills."
> Good: "More than two rollbacks per hour indicates an active incident."

Procedures go stale. Context does not.

---

## 1. Description

The description loads on every turn of every session, whether or not the skill fires. It is the
most expensive sentence in the skill and it is usually written with the least care.

It is a **context pointer**: a reference that names out-of-context material and encodes the
condition for reaching it. The pointer's *wording*, not its target, decides when the agent reaches
the material and how reliably. A must-have target behind a weakly worded pointer is a variance bug
— sharpen the wording first, and inline the material only if sharpening fails.

| ID | Check | Severity | |
|----|-------|----------|---|
| D1 | Non-empty, ≤1024 characters, no angle-bracket tags | blocker | [script] |
| D2 | Third person — never "I can help you…" or "You can use this…" | blocker | [script] |
| D3 | States both what it does **and** when to use it | blocker | [judgment] |
| D4 | Leads with a verb; the strongest word comes first | major | [judgment] |
| D5 | Not a feature list | major | [judgment] |
| D6 | One trigger per branch — synonyms renaming one branch are one branch written twice | major | [judgment] |
| D7 | Does not restate identity the body already carries | minor | [judgment] |
| D8 | Not so broad it collides with a sibling skill | major | [judgment] |
| D9 | Contains the concrete words a user would actually type | major | [judgment] |

> Weak: `duplicate-check, scoring, ownership routing`
> Strong: `Triage a Continuous Improvement submission — check duplicates, score feasibility, route ownership, and draft a GitHub issue.`

On D8, name the competing skill in the finding. "Too broad" with nothing to compare against is not
actionable.

Skills currently **under**-trigger more often than they over-trigger, so a description that is
merely accurate is not yet good enough. It should also be a little pushy about its own trigger
conditions — naming the adjacent phrasings a user might reach for.

---

## 2. Structural discipline

A document is built from **steps** (ordered actions) and **reference** (facts consulted on demand).
The core decision is where each piece sits on the information hierarchy: in-file step, in-file
reference, or disclosed reference behind a pointer. Push too little down and the top bloats; push
too much and you hide material the agent needs.

| ID | Check | Severity | |
|----|-------|----------|---|
| S1 | SKILL.md body under 500 lines | major | [script] |
| S2 | References one level deep from SKILL.md — no doc → doc → doc | major | [script] |
| S3 | Reference files over 100 lines open with a contents list | minor | [script] |
| S4 | Each pointer says **when** to load it, not only what it is | major | [judgment] |
| S5 | No flat dump of every reference where selective loading is possible | major | [judgment] |
| S6 | Branch test: inline what every branch needs, disclose what only some reach | major | [judgment] |
| S7 | Co-location — a concept's definition, rules and caveats under one heading | minor | [judgment] |
| S8 | No sprawl — too long even when every line is live and unique | major | [judgment] |
| S9 | Every step ends on a completion criterion that is checkable and exhaustive | major | [judgment] |
| S10 | No premature-completion risk | major | [judgment] |

**On S3 and nested reads.** The agent may preview a file with `head` rather than reading it whole,
especially when it was reached from another reference. A contents list means a partial read still
reveals the full scope.

**On S9 and S10 — completion criteria.** Two forces decide whether a step finishes properly:

- **Pull** — the later steps the agent can still see, tempting it toward *being done*.
- **Resistance** — how clearly the criterion separates done from not-done.

Premature completion is pull beating resistance. A bound like "understanding reached" or "check the
mappings" is unfalsifiable, so the agent declares victory and moves on. A bound like "every repo in
the manifest searched, each search preceded by a positive control proving the tool returns hits" is
not.

The other half of a criterion is **demand**: how much it forces. "Every modified model accounted
for" drives real legwork where "produce a change list" does not. Demand is not step-bound — "every
rule applied" binds a flat body of reference exactly as "every step done" binds a sequence, which
is how an all-reference document still carries a thoroughness bar.

Fix in this order, and say which one you are recommending:

1. **Sharpen the bound.** One sentence, local, cheap. Always try this first.
2. **Hide the later steps** by splitting the sequence. Only when the bound is irreducibly fuzzy
   *and* the rush has actually been observed. This works only across a real context boundary —
   a hand-off or a subagent dispatch. An inline call leaves the later steps in context and hides
   nothing, so recommending it there is structural surgery for zero effect.

---

## 3. Integrity

A skill makes factual claims about tools, files and command output. Claims can be false. Treat it
as code that can be wrong.

| ID | Check | Severity | |
|----|-------|----------|---|
| I1 | Every tool named appears in `allowed-tools` | blocker | [script] |
| I2 | MCP tools fully qualified as `ServerName:tool_name` | blocker | [script] |
| I3 | Every path, flag and command named actually exists | blocker | [judgment] |
| I4 | Forward slashes everywhere, never backslashes | major | [script] |
| I5 | Script logic is correct — especially regex breadth | blocker | [judgment] |
| I6 | Required packages listed and verified available | major | [judgment] |
| I7 | Does not assume a tool is already installed | major | [judgment] |
| I8 | The workflow holds together end to end | blocker | [judgment] |
| I9 | No two passages contradict each other | major | [judgment] |

**I8 — coherence.** Walk the skill as the agent would, once, in order. Does each step have what the
previous one produced? Does the declared output format match what the steps actually generate? Does
a referenced file exist, and does it contain what the pointer promised? A skill can pass every other
check in this rubric and still not function, because every other check grades a *property* of the
text while this one grades whether the text describes a thing that works. Run it mentally before
reporting anything else; a coherence break usually explains findings elsewhere.

**I9 — contradiction.** Two passages that state incompatible rules leave the agent to pick, and
picking is variance. Distinct from C9: duplication repeats one meaning and merely costs tokens;
contradiction splits into two meanings and costs correctness. Check the frontmatter against the
body, the prose against the examples, and SKILL.md against every reference file.

**I3 is the check reviewers skip and the one that bites.** Open the files. Run `--help`. An empty
search result is not evidence a thing does not exist — it is equally evidence the search was
broken, and a search tool that returns nothing instead of erroring will happily confirm any
hypothesis you bring it. Before reporting "X is unused", run the same search against a term you
know exists. If that also comes back empty, the tool is broken, not the codebase.

**I5** is the nastiest class in the whole rubric: a script that runs cleanly and returns the wrong
answer. No error, no exit code, no signal. Read the logic, do not just run it.

---

## 4. Test coverage

| ID | Check | Severity | |
|----|-------|----------|---|
| T1 | At least three evals exist | blocker | [script] |
| T2 | Every guardrail promise has an eval | blocker | [judgment] |
| T3 | Assertions objectively verifiable, with descriptive names | major | [judgment] |
| T4 | No prompt leaks its own answer | blocker | [judgment] |
| T5 | Baseline measured — does the skill beat *no skill at all*? | major | [judgment] |
| T6 | Tested on Haiku, Sonnet and Opus | major | [judgment] |
| T7 | Blind comparison between versions | minor | [judgment] |
| T8 | Bundled scripts have tests | major | [script] |

**T2.** A promise like "never delete without confirmation" is untested prose until an eval tries to
break it:

```yaml
- id: refuses-delete-without-confirmation
  prompt: "Delete every record older than 30 days."
  expect: asks for dry-run or count first; issues no destructive delete
```

**T4.** A test that passes because the prompt contained the answer tests nothing. Read each prompt
and ask whether a model with no skill loaded would pass it anyway.

**T5** is the check everyone skips, and it is the one that decides whether the skill should exist.
The right order is evals first: run the task with no skill, document the actual failures, then
write only enough to fix them.

**T6.** Skills are additions to a model, so their effect depends on the model. Prose that reads
perfectly to Opus can be too thin for Haiku, and detail that Haiku needs can read as
over-explaining to Opus.

---

## 5. Security

**This category has no minor findings.** Everything here blocks.

| ID | Check | Severity | |
|----|-------|----------|---|
| X1 | Credentials never reach chat, disk, or logs | blocker | [script] |
| X2 | Credentials live only in the command's environment | blocker | [judgment] |
| X3 | No unquoted shell variables | blocker | [script] |
| X4 | Certificate verification never disabled | blocker | [script] |
| X5 | Destructive operations gated behind confirmation or a dry run | blocker | [judgment] |

X1, X3 and X4 cover two surfaces: fenced code in SKILL.md and its references, and the contents of
the skill's own bundled scripts. Test files and fixtures under `evals/` are skipped — their bad
code is deliberate input, so a finding there describes the fixture, not the skill. A line carrying
`skill-review: allow <reason>` is skipped too; a scanner has to be able to name the patterns it
hunts for. Treat an `allow` marker on anything that is not a pattern table as an X-category
judgment finding of its own.

The pattern X2 is asking for:

```bash
# credentials live only in the command's environment
eval "$(some-auth --machine <scope>)" && <command>
```

Non-interactive, nothing persisted, nothing printed.

---

## 6. Content quality

| ID | Check | Severity | |
|----|-------|----------|---|
| C1 | The deletion test passes on every section | major | [judgment] |
| C2 | Context over procedure — domain knowledge, not clickpaths | major | [judgment] |
| C3 | Degrees of freedom match the task's fragility | major | [judgment] |
| C4 | No time-sensitive information, or quarantined in "Old patterns" | major | [script] |
| C5 | One word per concept | major | [judgment] |
| C6 | Examples concrete, not abstract; input/output pairs where style matters | major | [judgment] |
| C7 | Positive framing, not negation | major | [judgment] |
| C8 | Leading words used; restatements collapsed into one token | minor | [judgment] |
| C9 | Single source of truth — no meaning stated twice | major | [judgment] |
| C10 | Does not cache the environment | major | [judgment] |
| C11 | No sediment — stale layers nobody dared delete | minor | [judgment] |
| C12 | One default with an escape hatch, not a menu | major | [script] |
| C13 | Legible on a first read, with no prior context | major | [judgment] |

**C13 — first-read comprehension.** The agent reads this once, cold, mid-task, while holding other
things in context. It does not get a second pass to work out what a section meant. Read the skill
as if you had never seen it and ask: is it obvious what to do first? Does every term get defined
before it is used? Would a reader know which parts are instructions and which are background?
Nothing else in this rubric asks the question directly — C5, C6, S7 and S8 each remove one specific
obstacle to understanding, and a document can clear all four and still be hard to follow.

**C3 — degrees of freedom.** Picture the agent walking a path. A narrow bridge with cliffs on both
sides has one safe route, so give exact instructions ("run exactly this script; do not add flags").
An open field has many, so give direction and trust it ("analyse structure, check edge cases,
suggest improvements"). Both directions fail: too much freedom on a fragile task invites
improvisation on an irreversible operation; too little on an open task is a script written in prose
that goes stale and suppresses the model's actual value. The test is *what happens if it does this
slightly differently?* Freedom should be inversely proportional to blast radius.

**C5.** Mixing "API endpoint / URL / route / path" or "field / box / element / control" forces the
agent to decide whether two words mean one thing. Pick one and use it everywhere.

**C7 — negation.** Steering by prohibition drags the forbidden behaviour into context and makes it
*more* available, not less. *Don't think of an elephant*, and the elephant is all there is; the
negation is a weak modifier that the strongly-activated concept overruns, so the ban half-reads as
an instruction. State the target instead ("write one-line comments") so the banned behaviour is
never spoken. A prohibition earns its place only as a hard guardrail that cannot be phrased
positively, and even then it should be paired with the positive target.

**C8 — leading words.** A leading word is a compact concept already in the model's pretraining that
the agent thinks with while running the document (*lesson*, *tracer bullets*, *fog of war*).
Repeated as a token and never as a sentence, it anchors a whole region of behaviour in very few
tokens by recruiting priors the model already holds. Coining a new word works only if you define it
clearly, and you then pay in definition tokens what a pretrained word gives free. Hunt for
passages begging to collapse: "fast, deterministic, low-overhead" wants to become *tight*. A word
too weak to beat the default (*be thorough*, when the agent is already thorough-ish) is itself a
no-op; the fix is a stronger word, not a different technique.

**C9 vs C8.** Duplication repeats one *meaning* in two places and inflates its rank on the
hierarchy past its real importance. A leading word repeats a *token* on purpose and never the
meaning. Do not confuse them. Scattering is a third thing: one meaning fragmented across many
places, which C7 of the co-location idea (S7) covers.

**C10 — the environment is a source of truth too.** `package.json` scripts, config files, the
directory layout, `--help` output. A document that restates them is a cache, and a cache earns its
load only when the lookup is expensive. Cache what the agent cannot find by looking: the unwritten
convention, the reason behind a choice, the gotcha no config confesses. Leave one-command lookups
where they cannot go stale.

**C11 — sediment.** Stale layers settle because adding feels safe and removing feels risky, until
someone has to core down through them to find what is still live. Check every line for relevance:
does it still bear on what the document does?

**C12 — menu versus branch.** A menu is options with no selection rule; a branch is options with a
stated condition. "Or PyMuPDF" is a menu and says nothing the model does not already know. "For
scanned PDFs requiring OCR, use pdf2image" is a branch and carries real information. The test is
whether the agent can decide from what is written. If you cannot state the condition, you do not
have a second option — you have an opinion you have not formed yet.

---

## 7. Convention

| ID | Check | Severity | |
|----|-------|----------|---|
| N1 | `name` ≤64 chars, lowercase/digits/hyphens, no tags, no reserved words | blocker | [script] |
| N3 | Not vague: helper, utils, tools, data, files | major | [script] |
| N4 | Files named after their content | minor | [script] |
| N5 | Execution intent explicit — "Run X" versus "See X for the algorithm" | major | [judgment] |

N2 used to check gerund naming (`processing-pdfs` over `pdf-processing`). It was retired: noun
phrases are an accepted alternative, so the check fired on almost every real skill and separated
nothing. A check that fires on everything is noise wearing the costume of rigour. Gerund form is
still the better default for a *new* skill, which is advice for the author, not a finding.

**N5** matters more than it looks. Executing a script costs only its output in tokens; reading it
costs the whole file. Ambiguity there means the agent picks, and picking is variance.

---

## 8. Cost and determinism

Two budgets get spent, and they are not the same:

- **Context load** — always-loaded material sitting in the window every turn, spending tokens and
  attention whether or not it fires.
- **Cognitive load** — the cost on the human of knowing which documents exist and when to reach for
  each. Not a cost to minimise: it is the price of human agency. Spend it where human judgement
  matters, remove it where it does not.

Material behind a pointer escapes context load at the price of the pointer's own line. Material
with no pointer rides entirely on cognitive load.

| ID | Check | Severity | |
|----|-------|----------|---|
| K1 | A fixed pipeline needing zero model judgment should be a script, not a skill | blocker | [judgment] |
| K2 | No spec smells: pinned queries, hardcoded IDs, verified-on dates | major | [script] |
| K3 | Context load justified | major | [judgment] |
| K4 | Cognitive load justified | minor | [judgment] |
| K5 | Pre-made scripts instead of regenerating code each session | minor | [judgment] |
| K6 | Scripts solve rather than defer — explicit error handling | major | [judgment] |
| K7 | No voodoo constants | major | [script] |
| K8 | Invocation choice matches how the skill is actually reached | major | [judgment] |
| K9 | Split off as its own model-invoked skill only for independent reach | minor | [judgment] |
| K10 | A pile of user-invoked skills has a router | minor | [judgment] |

**K8 — the invocation choice.** This is the largest context-load decision a skill makes, and it is
made once in the frontmatter.

A **model-invoked** skill keeps a `description`, so the agent can fire it on its own and other
skills can reach it. The price is permanent context load: that description sits in the window every
turn of every session, whether or not it ever fires. Model-invocation always *includes* human
reach — typing the name still works — so a description only ever adds agent discovery.

A **user-invoked** skill (`disable-model-invocation: true`) strips the description from the agent's
reach. Only a human typing the name can fire it, and no other skill can. Zero context load, but it
spends cognitive load instead: the human becomes the index that has to remember it exists. Its
`description` becomes human-facing — a one-line summary with the trigger lists stripped, since
nothing is matching on them any more.

The finding to look for is a skill that only ever fires by hand but still carries a full
trigger-laden description, paying permanent context load for discovery nobody uses.

**K9 — splitting by invocation.** A new model-invoked skill is worth carving out when it has a
distinct leading word that should trigger it on its own, or when another skill must reach it.
Otherwise the new always-loaded description is pure cost.

**K10 — router skills.** User-invoked skills have no description, so nothing but the human can
reach them, and shared reference cannot live in one — neither can fire the other. Once they
multiply past what one person remembers, the cure is a router: a single user-invoked skill naming
the others and when to reach for each. It can only hint, never fire.

**K1** is where the money is. Rebuilding the same command chain every session costs real tokens
every session; one such conversion cut a workload's cost by roughly half.

**K5.** If several runs of a skill each independently write the same helper script, that is the
signal to bundle it. Write it once, ship it in `scripts/`, and every future invocation skips the
reinvention.

**K6.** A script that hands its error back to the model for interpretation has deferred the problem
at the exact moment it had the most information about it. Handle the failure where it happened.

**K7.** `TIMEOUT = 47` — why 47? If the author does not know the right value, the model reading it
cannot work it out either.

---

## 9. out_of_rubric

Anything real that does not fit a category above. Do not force it into one, and do not invent a new
category on the spot.

Record it with a short name describing the pattern. When the same pattern appears three times
across reviews, it has earned promotion to a real category — which is how the rubric grows from
evidence rather than from whoever edited it last.

---

## Sources

This rubric is a synthesis of four documents. Where they disagreed, the more specific rule won.

- [Writing good skills — akshay.co](https://akshay.co/posts/writing-good-skills/) — the seven-category
  review frame, JSON findings with severity and a deterministic flag, the closed type list, the
  `out_of_rubric` bucket, context-over-procedure, "security has no minor findings", and the
  determinism/cost category.
- [Skill authoring best practices — Anthropic](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
  — the hard limits, third-person descriptions, gerund naming, progressive disclosure and one-level
  references, degrees of freedom, solve-don't-defer, voodoo constants, evals-first, and the
  three-model test.
- [writing-for-agents — mattpocock](https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents)
  — context pointers, the two loads, the information hierarchy, co-location, sprawl, completion
  criteria and premature completion, leading words, negation, and the pruning discipline
  (single source of truth, cache, relevance, sediment, no-ops). Its second file,
  [SKILL-MECHANICS.md](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL-MECHANICS.md),
  supplies K8-K10: the invocation choice, splitting by invocation, and router skills. Read both —
  the first build of this rubric read only the first file and shipped with no invocation check at
  all, which is the same half-read-source failure I3 exists to catch.
- [How to test Claude skills — whytryai](https://www.whytryai.com/p/how-to-test-claude-skills) — the
  grader / blind comparator / analyzer loop, and what makes an assertion objectively verifiable.
