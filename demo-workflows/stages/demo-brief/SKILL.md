---
name: demo-brief
description: Test stage. Turns the run's prompt into a one-paragraph brief.
mode: inline
allowed-tools: [Bash, Write]
tier: fast
inputs:
  description: The topic to brief.
  schema: demo-brief.input.v1
outputs:
  description: Where the brief was written.
  schema: demo-brief.output.v1
  module: ../schemas.ts
produces:
  - artifact: brief
protocols: []
scopes: []
---

# Demo Brief

A test stage for workflow runs. The input is `{ "topic": TOPIC }`.

## Steps

1. Write two sentences about `TOPIC` to `.harness/RUN_NAME/artifacts/brief.md`, where
   `RUN_NAME` is the run's name.
2. Finish the node with `--artifact brief=artifacts/brief.md`, and reply with:

   ```json
   { "brief": "artifacts/brief.md" }
   ```
