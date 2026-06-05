# proof-report.md sections (in this order)

1. **Summary table** — scenario ID | type | description | verdict
2. **API evidence** — curl + truncated responses (link to `verification/api/*.txt`)
3. **UI evidence** — one row per (route, viewport) with screenshot path (committed under `verification/screenshots/`)
4. **DB evidence** — queries + results
5. **Visual anomalies & UX observations** — every `UNMET` finding (spec or open-review): which screenshot, what's wrong, evidence (rect / quoted text / computed style / network response). If clean: "Second pass clean across N screenshots; per-screenshot notes in observations.md." Never omit this section.
6. **Spec coverage table** — REQ-N / EDGE-N → scenario → evidence path. Gaps listed as `NOT VERIFIED` with reason.
7. **E2E coverage summary** — which requirements were `COVERED_BY_E2E` (skipped here, proven during coding). Reference `.harness/runtime/<SPEC_NAME>/e2e-report.json`. If absent: note all scenarios were run fresh.
8. **Adversarial findings** — quote (do not paraphrase) findings from `verification/adversarial-findings.md`. For each: description, inputs, actual outcome, verdict (defect / expected). If clean: "Adversarial pass clean — N scenarios attempted, all behaved correctly."
9. **Not executed** — what this skill genuinely cannot verify, with reason.
10. **Infrastructure** — what was started, when it was cleaned up, what was already running.
