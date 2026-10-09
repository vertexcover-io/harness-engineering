# learn: baseline

Measured with the simulated sessions in `sim/` (Claude Code 2.1.x; agent and simulated user on
Sonnet; correction check on Haiku), on harness and yok, October 2026.

## Auto trigger

The hook in `hooks/hooks.json` exists because the skill's description alone rarely gets it run.

| Setup | Corrections that triggered learn | One-offs that wrongly triggered it |
|---|---|---|
| Description only, first wording | 0 of 6 | 0 of 6 |
| Description only, imperative "run this as soon as…" | 1 of 6 | 0 of 6 |
| Hook, regex check | 2 of 3, both mid-task; missed 2 of 3 real corrections, flagged 2 non-corrections | 0 of 3 |
| Hook, Haiku check with regex fallback | 6 of 6, all after the work was done | 0 of 6 |

The regex missed corrections such as "Hold on, did you hardcode … in both apps?" and "shared-config
already has a place for this", and flagged "did the switch go in on both apps?". The Haiku check
read all of them right, in 4 to 8 seconds, in the background.

## Final run: every scenario, both plugins

34 sessions: auto-shared-list and auto-one-off 3 times each, every other scenario once.

- 33 of 34 passed after fixes found by the run. The remaining one was a false positive the skill
  proposed (a one-off sandbox setup issue) that the user rejected; the rejection and its reason were
  logged, which is the signal this logging exists for.
- 24 of 24 runs that logged an event reached Samskara: row stored, fields matching the JSONL,
  linked to the session's project, and the evidence messages covering the exchange.
- Occurrence was not exercised in the final run: in both runs the agent read the existing learning
  and did not repeat the mistake. It passed in earlier rounds.

## Agent model

Three scenarios (several-real-fixes, manual-with-text, auto-shared-list) with only the agent's model
changed (`SIM_AGENT_MODEL`); the simulated user and grader stayed on Sonnet. Harness, one run each.

| Agent | Result |
|---|---|
| Sonnet | 3 of 3 (and the full run above) |
| Opus | 2 of 3; the third offered a lint check and a written learning together, the user took the learning, and both were logged (`lint/rejected`, `new/accepted`): accurate, but step 3 meant one or the other |
| Haiku | 0 of 3: ignored the learning format (no signal, Occurrences or Stale when), skipped logging a user-stated rule, proposed before fixing the code, logged one learning twice, and dropped the evidence ids |

The skill needs Sonnet or Opus as the agent. On Haiku the learning files and the events are not
reliable enough to keep.

## Not measured yet

- Real sessions. These are scripted users in one dummy repo; the Learn events page in Samskara
  shows the real accept and reject rates once people use it.
