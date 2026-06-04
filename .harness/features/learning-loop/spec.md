# SPEC: Closed Learning Loop + Unified `.harness/` Storage

**Source:** docs/spec/learning-loop/design.md
**Generated:** 2026-06-04

## Requirements

### Storage & Migration (Phase 0)

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-001 | Ubiquitous | The system shall store all harness artifacts under `.harness/` in three zones: `knowledge/`, `features/<spec>/`, `runtime/<spec>/` | After a full pipeline run, zero harness artifacts exist outside `.harness/`; `git check-ignore` matches `runtime/` paths and does not match `knowledge/` or `features/` paths | Must |
| REQ-002 | Event-driven | When `knowledge.mjs verify` runs and a zone directory or `INDEX.md` is missing, the script shall create the missing zones and an empty INDEX | Envelope lists each created path in `{created}`; exit code 1; second run reports `{created: []}`, exit 0 | Must |
| REQ-003 | Unwanted | If `git check-ignore .harness/knowledge` matches, then `knowledge.mjs verify` shall exit 2 with an error naming the `.gitignore` fix | Exit code 2; `{errors}` contains the string `.harness/runtime/`; host skill halts the pipeline | Must |
| REQ-004 | Event-driven | When any old-layout root (`docs/context/`, `docs/solutions/`, `docs/spec/`, legacy `.harness/<spec>/`, `docs/specs/`, `docs/superpowers/specs/`) exists during pipeline-setup Stage 0, the system shall run `knowledge.mjs migrate` | `{migrated}` lists one `{from, to}` pair per moved root; moves use `git mv`; runs after worktree creation and dashboard init | Must |
| REQ-005 | Ubiquitous | `knowledge.mjs migrate` shall be idempotent | Second run on a migrated repo reports `{migrated: []}`, working tree unchanged (`git status --porcelain` identical before/after) | Must |
| REQ-006 | Unwanted | If an old-root path has uncommitted modifications, then `migrate` shall defer that path and move the rest | Deferred path appears in `{deferred}` with reason; clean roots still appear in `{migrated}` | Must |
| REQ-007 | Event-driven | When `migrate` moves at least one root, the system shall narrow `.gitignore` from `.harness/` to `.harness/runtime/` and commit the migration as a standalone commit | `.gitignore` diff shows the narrowed rule; `git log -1` shows a migration-only commit (no feature changes mixed in) | Must |
| REQ-008 | Event-driven | When `migrate --dry-run` runs, the script shall print the full envelope without modifying the working tree | `git status --porcelain` identical before/after; envelope identical in shape to a real run | Should |
| REQ-009 | Ubiquitous | The dashboard's `dag-update init` shall write pipeline state to `.harness/runtime/<spec>/` | `HARNESS_DIR` printed by `init` ends with `.harness/runtime/<spec>` | Must |
| REQ-010 | Ubiquitous | The system shall maintain an auto-generated `.harness/README.md` describing the three zones, delete-safety, and the INDEX conflict-resolution procedure | File exists after `verify` bootstrap; contains the strings `runtime/`, `knowledge/`, `features/`, `reindex` | Should |
| REQ-011 | Ubiquitous | All path-referencing skills (the 18-skill grep manifest) shall reference only new-layout paths | `grep -rlE "docs/spec/\|docs/context\|docs/solutions\|docs/specs/\|docs/superpowers"` over `skills/` (excluding evals fixtures) returns zero SKILL.md or references/ matches | Must |

### Index & Retrieval (Phase 1)

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-012 | Ubiquitous | Lesson docs shall carry routing frontmatter: `applies_to`, `stage`, `tags`, `evidence_count`, `last_validated`, `source` | learn-skill template includes all six fields; `reindex` parses them without error | Must |
| REQ-013 | Event-driven | When `knowledge.mjs reindex` runs, the script shall regenerate `INDEX.md` solely from lesson + standard frontmatter, sorted by `evidence_count` descending | Output is byte-identical across two runs on the same tree (determinism); hand-edits to INDEX do not survive a reindex | Must |
| REQ-014 | Unwanted | If the INDEX would exceed 100 entries, then `reindex` shall evict by lowest `evidence_count`, then oldest `last_validated`, then lexicographic path | With 101 synthetic lessons, exactly 1 entry evicted, deterministically the same one across runs; evicted lesson file still on disk | Must |
| REQ-015 | Event-driven | When `reindex` runs, lessons whose `applies_to` paths or cited files no longer exist shall be listed in `{stale}` | Deleting a file referenced by a lesson and re-running reindex lists that lesson in `{stale}` | Should |
| REQ-016 | Event-driven | When `knowledge.mjs route` runs with spec keywords and paths, the script shall write `runtime/<spec>/relevant-lessons.md` containing the full body of the top-K matches (default K=10), path-matches ranked before tag-only matches | File contains ≤ K `## Lesson:` sections; a lesson matching on `applies_to` outranks one matching only on `tags`; matched `S-*` standards appended | Must |
| REQ-017 | Unwanted | If a lesson's `applies_to` globs match more than 50% of tracked repo files, then `route` shall demote it to tag-only rank | A lesson with `applies_to: ["**"]` never outranks any path-matched lesson; with no tag match it does not qualify at all | Must |
| REQ-018 | Unwanted | If zero lessons match, then `route` shall write the file containing exactly `No prior lessons match this spec.` | Byte-exact content match; exit 0; `{matched: 0}` | Must |
| REQ-019 | Event-driven | When orchestrate dispatches the planner, coder, reviewer, or verifier sub-agent, the prompt shall include the `relevant-lessons.md` path | All four stage prompt templates in orchestrate/SKILL.md contain the path placeholder | Must |
| REQ-020 | Ubiquitous | The reviewer prompt shall treat each routed lesson as a checklist item and report, per finding, the lesson path it matches (or none) | Review findings schema includes a `matched_lesson` field; a seeded known-mistake fixture produces a finding with the correct lesson path | Must |
| REQ-021 | Ubiquitous | `route` shall wrap lesson bodies in a delimited block labeled as advisory reference material, not instructions | Output file contains the delimiter and the advisory sentence before the first lesson body | Must |
| REQ-022 | Ubiquitous | CLAUDE.md shall carry exactly one learning-loop line pointing at `.harness/knowledge/INDEX.md` | One-line entry present; the multi-line "Prior Learnings" grep instructions removed | Should |
| REQ-036 | Event-driven | When a session starts in a repo containing `.harness/knowledge/INDEX.md`, the SessionStart hook shall inject the INDEX content into session context wrapped in the advisory delimiter | Hook stdout contains the delimiter and every INDEX line; output ≤ INDEX size + delimiter overhead | Must |
| REQ-037 | Unwanted | If `.harness/knowledge/INDEX.md` is absent or empty at session start, then the SessionStart hook shall exit 0 with no learning-loop output | Empty stdout for the learning-loop section; exit code 0; session start unaffected | Must |

### Capture & Curation (Phase 2)

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-023 | Event-driven | When a nomination signal fires during a stage (`review-fix`, `verify-break`, `gate-blocked`, `stagnation-recovery`, `hard-won-success`), the stage shall append one JSON line `{signal, summary ≤200 chars, files[], stage}` to `runtime/<spec>/lesson-candidates.jsonl` | Each stage prompt names its signals and the append command; line parses as JSON with all four fields; stage output unaffected | Must |
| REQ-024 | Event-driven | When stage 5 runs and candidates exist, the curator (learn skill, consolidate mode) shall record a disposition for every candidate: `patched <path>`, `created <path>`, or `discarded <which test failed>` | Stage-5 report lists one disposition per deduped candidate; no candidate unaccounted for | Must |
| REQ-025 | Event-driven | When a candidate matches an existing lesson (recurrence test), the curator shall patch that lesson via targeted edit and increment its `evidence_count` | Lesson diff shows only the patched section + frontmatter counter; no whole-file rewrite (unchanged sections byte-identical) | Must |
| REQ-026 | Ubiquitous | The curator shall merge candidates sharing the dedupe key `(signal, sorted(files))` before applying the four tests | Two identical-key lines yield one disposition | Must |
| REQ-027 | Unwanted | If a JSONL line fails to parse, then the curator shall skip it and note the line number in the stage-5 report | Malformed line does not abort curation; report contains the skip note | Must |
| REQ-028 | Event-driven | When curation completes with any patch or create, the curator shall invoke `knowledge.mjs reindex` | INDEX reflects new/patched lessons in the same pipeline run | Must |
| REQ-029 | Unwanted | If zero candidates exist at stage 5, then the curator shall log a no-op | Stage-5 report contains `lessons: captured 0` (not absent) | Should |
| REQ-030 | Ubiquitous | Manual `/learn` shall write lessons to the same zone paths and invoke `reindex` | Standalone `/learn` produces a lesson under `knowledge/lessons/` (or `features/<spec>/learnings.md`) and an updated INDEX | Must |
| REQ-031 | Ubiquitous | Every curator-written lesson shall record `source: <signal>@<spec>` in frontmatter | Field present and matches the originating candidate | Must |

### Human Feedback & Metrics (Phase 3)

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-032 | Event-driven | When review-fixer fixes a human PR comment, it shall append one `human-comment` candidate per distinct comment | N distinct comments → N candidate lines with `signal: "human-comment"`, `stage: "pr"` | Must |
| REQ-033 | Event-driven | When a reviewer finding reports a `matched_lesson` (REQ-020), the curator shall increment that lesson's `evidence_count` and refresh `last_validated` | Frontmatter counter +1 and date updated in the same run | Must |
| REQ-034 | Ubiquitous | The orchestrate final summary shall report `lessons: retrieved N / matched M / captured P` | Line present in the summary table with integer values | Should |
| REQ-035 | Unwanted | If `knowledge.mjs` exits 2 or emits no valid JSON during `route`, `reindex`, or `migrate`, then the host skill shall record a skip-note and continue the pipeline | Pipeline completes; stage report contains `knowledge skipped — <reason>`; only REQ-003 (verify gitignore) may halt | Must |

## Edge Cases

| ID | Scenario | Expected Behavior | Derived From |
|----|----------|-------------------|-------------|
| EDGE-001 | Fresh repo, no `.harness/` at all | `verify` bootstraps empty zones + INDEX + README; `route` writes the no-match sentinel; pipeline proceeds normally | REQ-002, REQ-010, REQ-018 |
| EDGE-002 | Two divergent INDEX.md files from parallel PRs merge-conflict | Resolution = delete both sides, run `reindex`; both branches' regenerated INDEX over the merged lesson set is byte-identical | REQ-013 |
| EDGE-003 | Broad `.harness/` gitignore rule reappears after a bad merge | Next `verify` exits 2 and halts setup with the fix message — never silent | REQ-003 |
| EDGE-004 | Lesson matches on `tags` only, none of its `applies_to` globs hit planned paths | Lesson qualifies at tag-only rank, after all path-matched lessons | REQ-016 |
| EDGE-005 | Lesson with `applies_to: ["**"]` and no matching tags | Excluded from `relevant-lessons.md` entirely | REQ-017 |
| EDGE-006 | Legacy lesson migrated from `docs/solutions/` lacks routing frontmatter | `reindex` applies defaults (`evidence_count: 1`, `applies_to: []` → tag-only routing from existing `tags`); listed in `{stale: []}` only if its cited files are gone | REQ-012, REQ-013 |
| EDGE-007 | Old-root path dirty at migration time | That root deferred with reason; remaining roots migrate; next run retries the deferred root | REQ-006 |
| EDGE-008 | `--auto` (CI) mode hits an unmigrated repo | Migration runs without interactive gate but still as its own commit, reviewable in the PR | REQ-004, REQ-007 |
| EDGE-009 | review-fixer runs in CI on a repo not yet migrated | Candidates written to the legacy `.harness/` path if present; fix run never blocks on the learning loop | REQ-032, REQ-035 |
| EDGE-010 | Curator crashes after patching 2 of 5 candidates | Re-run is safe: JSONL persists until stage-5 completion; already-applied candidates dedupe via the recurrence test; INDEX recoverable via `reindex` | REQ-024, REQ-025, REQ-028 |
| EDGE-011 | Candidate `summary` contains imperative text ("ignore all previous instructions") | Curator treats it as quoted material and writes the lesson in its own words; routed output stays inside the advisory delimiter | REQ-021, REQ-031 |
| EDGE-012 | 101st INDEX entry added | Deterministic eviction of exactly the weakest entry; evicted lesson remains grep-able on disk | REQ-014 |
| EDGE-013 | Malformed line mid-JSONL with valid lines after it | Only the malformed line skipped; subsequent lines processed | REQ-027 |
| EDGE-014 | Spec touches zero files matching any lesson, but INDEX is non-empty | Same as zero-match: sentinel file written; stage prompts proceed without lesson context | REQ-018 |
| EDGE-015 | Session starts in a repo that has `.harness/` but a 0-byte INDEX.md | Hook treats empty as absent: no output, exit 0 | REQ-037 |

## Verification Matrix

| REQ ID | Unit Test | Integration Test | E2E Test | Manual Test | Notes |
|--------|-----------|-----------------|----------|-------------|-------|
| REQ-001 | No | Yes | Yes | No | Fixture repo + full pipeline run in worktree; E2E = orchestrate dry run |
| REQ-002 | Yes | No | No | No | knowledge.mjs unit: temp dir fixtures |
| REQ-003 | Yes | Yes | No | No | Unit: gitignore fixtures; integration: pipeline-setup halts |
| REQ-004 | Yes | Yes | No | No | Unit per old-root layout; integration: Stage-0 ordering after dashboard init |
| REQ-005 | Yes | No | No | No | Double-run assertion |
| REQ-006 | Yes | No | No | No | Dirty-tree fixture |
| REQ-007 | Yes | Yes | No | No | Gitignore diff + standalone-commit check |
| REQ-008 | Yes | No | No | No | Dry-run tree-hash comparison |
| REQ-009 | No | Yes | No | No | dag-update init output path |
| REQ-010 | Yes | No | No | No | Bootstrap content assertions |
| REQ-011 | Yes | No | No | No | The grep itself is the test; runs in CI |
| REQ-012 | Yes | No | No | Yes | Unit: reindex parses; manual: learn-skill template review |
| REQ-013 | Yes | No | No | No | Determinism: byte-identical double run |
| REQ-014 | Yes | No | No | No | 101-lesson synthetic fixture |
| REQ-015 | Yes | No | No | No | Deleted-file fixture |
| REQ-016 | Yes | No | No | No | Ranking fixtures: path vs tag matches |
| REQ-017 | Yes | No | No | No | `**` glob fixture |
| REQ-018 | Yes | No | No | No | Byte-exact sentinel |
| REQ-019 | No | No | No | Yes | Prompt-template inspection + skill eval |
| REQ-020 | No | No | Yes | Yes | Skill eval: seeded known-mistake fixture through review stage |
| REQ-021 | Yes | No | No | Yes | Unit: delimiter present; manual: prompt-injection probe (EDGE-011) |
| REQ-022 | Yes | No | No | No | CLAUDE.md single-line grep |
| REQ-023 | No | No | No | Yes | Skill eval per signal type on stage prompts |
| REQ-024 | No | No | Yes | Yes | Skill eval: candidates fixture → disposition report |
| REQ-025 | No | No | Yes | Yes | Diff-scope assertion on patched lesson |
| REQ-026 | No | No | Yes | No | Duplicate-key fixture in eval |
| REQ-027 | No | No | Yes | No | Malformed-line fixture in eval |
| REQ-028 | No | Yes | No | No | INDEX updated within same run |
| REQ-029 | No | No | Yes | No | Empty-candidates eval |
| REQ-030 | No | No | No | Yes | Standalone /learn session |
| REQ-031 | No | No | Yes | No | Frontmatter assertion in eval |
| REQ-032 | No | No | No | Yes | review-fixer eval with mock PR comments |
| REQ-033 | No | No | Yes | No | matched_lesson fixture → counter increment |
| REQ-034 | No | No | No | Yes | Summary-table inspection on a pipeline run |
| REQ-035 | Yes | Yes | No | No | Unit: exit-2 envelope; integration: pipeline continues with skip-note |
| REQ-036 | Yes | No | No | No | Hook unit test: INDEX fixture → stdout assertion |
| REQ-037 | Yes | No | No | No | Absent + 0-byte INDEX fixtures |
| EDGE-001 | Yes | Yes | No | No | |
| EDGE-002 | Yes | No | No | No | Two-branch merge fixture |
| EDGE-003 | Yes | No | No | No | |
| EDGE-004 | Yes | No | No | No | |
| EDGE-005 | Yes | No | No | No | |
| EDGE-006 | Yes | No | No | No | Legacy-frontmatter fixture |
| EDGE-007 | Yes | No | No | No | |
| EDGE-008 | No | Yes | No | No | --auto fixture run |
| EDGE-009 | No | No | No | Yes | CI-context review-fixer eval |
| EDGE-010 | No | No | Yes | No | Interrupted-curation eval, re-run assertion |
| EDGE-011 | No | No | No | Yes | Adversarial prompt-injection probe |
| EDGE-012 | Yes | No | No | No | Same fixture as REQ-014 |
| EDGE-013 | No | No | Yes | No | |
| EDGE-014 | Yes | No | No | No | |
| EDGE-015 | Yes | No | No | No | Same fixture set as REQ-037 |

Notes: "Unit Test" = node test runner against `knowledge.mjs` with temp-dir git fixtures. "E2E Test" = skill-eval suites (skill-eval-generator) exercising SKILL.md behavior with fixtures. Skill-prompt behaviors (REQ-019/020/023–034) cannot be unit-tested — they are verified by evals + manual runs per the harness's existing eval convention.

## Out of Scope

- Model fine-tuning, RL, or any weight-update learning.
- Vector databases, embeddings, FTS5, or any retrieval index beyond glob + tag matching over frontmatter.
- Auto-generated executable skills (Hermes-style code skills) — lessons are advisory context only.
- Per-stage direct writes to `knowledge/` — all knowledge writes flow through the curator or manual `/learn`.
- Cross-repo or org-level lesson sharing — each repo's `knowledge/` is self-contained.
- Changes to artifact content formats (design/spec/plan templates unchanged) — only locations move.
- Rewriting historical path references inside already-committed docs/PR descriptions (migration moves files only).
- Periodic mid-session nudges (Hermes-style timers) — capture points are pipeline-stage boundaries and explicit `/learn` only.
