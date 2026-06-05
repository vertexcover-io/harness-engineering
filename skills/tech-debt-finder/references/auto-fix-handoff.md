# Automated Fix Hand-off Contract

Defines how an automated fix pass (e.g. the CI "Code Health" pipeline that chains
`tech-debt-finder` → `orchestrate --auto`) consumes tech-debt findings **without losing
them**. The whole point of this contract is that every finding the scan produced reaches a
tracked terminal state — nothing silently evaporates between scan and PR.

## The failure this prevents

Without a structured hand-off, the scan→fix bridge degrades into two lossy compressions: the
scanner collapses machine-readable findings into prose, then the fixer re-collapses that prose
(from conversational memory) into a hand-written fix list. Findings disappear with no record —
a confirmed-unused file never gets deleted, an agreed fix is dropped before the coder sees it,
and 900 duplication clones become "4 findings" with no audit trail. The fix list also stops
being reproducible: a re-run produces whatever the model happened to remember.

## Rule 1 — Consume the manifest, never the prose

The fix pass MUST read the structured manifest `tech-debt-finder` wrote:

```
.harness/runtime/tech-debt/<YYYY-MM-DD>/findings.json
```

It MUST NOT reconstruct the fix list from the terminal report, the GitHub issue bodies, or
conversational memory. The manifest is the single source of truth. If the manifest is missing,
the fix pass stops with an error — it does not improvise a list.

Each manifest entry has the shape:

```json
{
  "id": "code-smell:unused-export:packages/web/src/lib/format.ts:42",
  "category": "code-smell",
  "rule": "unused-export",
  "file": "packages/web/src/lib/format.ts",
  "line": 42,
  "severity": "Low",
  "detail": "...",
  "fix_hint": "...",
  "auto_fixable": true,
  "fallow_action": "remove-export",
  "source": "fallow",
  "issue_number": 239,
  "disposition": "pending"
}
```

## Rule 2 — Eligibility is the `auto_fixable` flag, not a judgement call

A finding is eligible for automated fixing **iff `auto_fixable == true`**. Do not re-derive
"low-risk" from prose — the flag already encodes it deterministically.

`auto_fixable` is `true` only when the finding carries a fallow **remediation** action that
removes the debt from the code — `remove-dependency`, `delete-file`, `remove-export`,
`remove-unused-import`, and the like. It is `false` when the only available actions are
suppressions (`add-to-config`, `suppress-line`, `ignore-*`) — those hide a finding, they do
not fix it. It is always `false` for LLM-pattern, architecture, complexity, and duplication
findings: those require human-reviewed refactoring and stay as issues.

Eligible findings → fix them. Every other finding → `disposition: "issue"` (already filed in
Step 5). Ineligibility is never a reason to drop a finding from the manifest.

## Rule 3 — Every finding reaches a terminal disposition

After the fix pass, write `.harness/runtime/tech-debt/<YYYY-MM-DD>/fix-manifest.json`. **Every** `id`
from `findings.json` MUST appear with exactly one terminal `disposition`:

| disposition  | meaning |
|--------------|---------|
| `fixed`      | the fix is in the diff |
| `issue`      | not auto-fixable; tracked by its GitHub issue (`issue_number` required) |
| `suppressed` | matched a rule in `.claude/harness/tech-debt-ignore.md` (record the rule) |
| `dropped`    | deliberately not actioned — **`reason` is REQUIRED and must be non-empty** |

## Rule 4 — Reconcile, and fail loudly on silent loss

Before committing, assert:

1. `fixed + issue + suppressed + dropped == total` (every finding accounted for, no gaps).
2. **No `auto_fixable: true` finding has disposition `dropped` or `pending`.** If one does, the
   pipeline FAILS (in `--auto`, abort before commit and report which findings and why). An
   eligible fix that is neither applied nor explicitly justified is a bug, not a default.
3. Every `dropped` entry has a non-empty `reason`.

A finding may be legitimately `dropped` (e.g. the fix turned out to break typecheck) — but only
*with a reason on the record*. The forbidden state is a finding vanishing with no trace.

## Rule 5 — Surface coverage in the PR

The PR body MUST include the reconciliation table so a reviewer sees the whole funnel, not just
what was changed:

```
| Disposition | Count |
|-------------|-------|
| fixed       | 7     |
| issue       | 38    |
| suppressed  | 280   |
| dropped     | 2     |
| **total**   | 327   |

Dropped (with reasons):
- <id> — <reason>
```

## Reducing noise the right way

High-volume, low-value findings (duplicated test scaffolding, script/probe entry points that
legitimately have no importers) should be **suppressed**, not silently dropped — add rules to
`.claude/harness/tech-debt-ignore.md` (see `suppression-rules.md`). Suppressed findings are still
counted in the manifest (`disposition: "suppressed"`), so the noise is removed *and* visible, and
the next run does not re-triage the same boilerplate from scratch.

Note: suppression matching is currently exact-path + `*` only (no directory globs), so broad
classes are suppressed either per file or with a global `*:<rule>` rule (e.g. `*:code-duplication`
to drop duplication findings wholesale). Directory-scoped suppression (e.g. ignore duplication
only under `tests/`) is a known gap — track it as a separate enhancement rather than papering over
it by dropping findings here.
