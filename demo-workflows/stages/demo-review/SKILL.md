---
name: demo-review
description: Test stage. Reviews every draft against the brief.
mode: inline
allowed-tools: [Bash, Read, Write]
tier: fast
inputs:
  description: How many loop passes the drafts took.
  schema: demo-review.input.v1
outputs:
  description: Where the review was written and how many drafts it read.
  schema: demo-review.output.v1
  module: ../schemas.ts
consumes:
  - artifact: brief
  - artifact: draft
produces:
  - artifact: review
protocols: []
scopes: []
---

# Demo Review

A test stage for workflow runs. The input is `{ "passes": N }`. `RUN_NAME` below is the run's
name.

## Steps

1. Read `.yok/RUN_NAME/artifacts/brief.md` and every file in
   `.yok/RUN_NAME/artifacts/drafts/`.
2. Write one line to `.yok/RUN_NAME/artifacts/review.md`:
   `Reviewed D drafts after N loop passes: NAME1, NAME2, …`.
3. Finish the node with `--artifact review=artifacts/review.md`, and reply with:

   ```json
   { "review": "artifacts/review.md", "drafts": D }
   ```
