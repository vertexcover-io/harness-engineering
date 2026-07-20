# Spec Review Rubric

Used in Phase 7. Dispatch a fresh subagent with the design doc + this rubric (NOT
session history). Iterate fixes; max 5 iterations, then surface to human.

The review checks:

- **Completeness vs. the lens list** — every stress-test lens (`stress-test-lenses.md`)
  addressed or consciously excluded.
- **EARS-style requirement IDs** — functional (F#), non-functional (NF#), edge cases
  (EC#), one behavior per ID.
- **YAGNI pass evidence** — knobs/flags justified as needed now, or hardcoded.
- **No tautological assumptions** — no verified facts, no "we'll see".
- **Contract clarity** — boundaries and interfaces unambiguous.
- **Missing sections** — every required design-template section present.
- **PRD integrity** — section always present, with full subsections OR (internal-facing
  only) the `No PRD — internal-facing change.` sentinel as its body. Every user flow's
  behavior covered by at least one F#. No criteria text duplicated between PRD and
  Requirements.
