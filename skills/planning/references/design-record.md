# design.md — the machine record of the checkpoint

Path: `.harness/<name>/design.md`. Written by a **recorder sub-agent dispatched at the
checkpoint**. Read by `code-review`'s spec persona. **No approval gate applies to this
file.** The human approves the inline summary, never this file. It is agent-facing — keep
entries exact and complete.

## Dispatch — what the recorder receives

The recorder cannot see the conversation. The dispatch prompt must carry, verbatim:

- the resolved decision list (every `D<n>` from the written tree, with status)
- the external dependencies the solution names, with env keys and fallback order
- questions resolved during the grill, and any the user chose to defer
- a `file:line` citation for every decision that rests on code

The recorder formats; it does not decide. A decision missing from the dispatch prompt is lost —
the main agent owns completeness, not the recorder.

## Sections

| Section | Holds | Rule |
|---|---|---|
| `## Decisions` | one row per fork taken | the core — see shape below |
| `## External Dependencies & Fallback Chain` | every external library, API, or service named | exact shape below; omit only when no external dependency exists |
| `## Resolved questions` | each question the grill settled, with its answer | plain question, plain answer |
| `## Deferred` | questions the user chose to defer | only user-deferred items; nothing self-deferred |

Omit an empty section. Never pad with "None".

## `## Decisions` — shape

One row per fork. Three columns: what we do, the alternative rejected, the reason.
Name the mechanism concretely: the service, the field, the value. Mark forks closed on the
user's behalf `— inferred`; they are bets a reviewer should check.

```markdown
| # | What we do | Instead of | Because |
|---|---|---|---|
| D1 | Store the token hashed, in the existing sessions table | a new tokens table | credentials already persist this way; a second store is a second thing to audit |
| D2 | A user session gets 401 — *inferred* | 403 | the platform already answers user JWTs on app-token endpoints with 401 |
```

Cite PRD story ids in the `Because` column where a story drives the fork. A decision the PRD
never asked about cites `grill finding`.

## `## External Dependencies & Fallback Chain` — shape

Keep the headings verbatim — dependency tooling parses this section.

```markdown
## External Dependencies & Fallback Chain

### Primary: <lib-name>
- **Purpose:** <what it does in this feature>
- **Use cases to probe:** <distinct flows; e.g. "single tweet, list, thread">
- **Auth:** <none | api-key | oauth | cookies>
- **Required env keys:** TWITTER_BEARER_TOKEN, ... (loaded from project-root `.env.harness`)

### Fallbacks (in order)
1. <alt-lib-1> — <why this is the fallback>
2. build-custom — <approach>
```

A dependency is external when it is not in this repo: a package, a hosted API, a managed
service. The standard library and first-party packages are not.

## What this file never holds

- Problem statements, context essays, approach prose — the inline summary carried those; the
  plan carries what the coders need.
- Requirements or edge cases — the PRD owns them; cite ids only.
- Process notes ("captured at phase 3", "next: phase design").
