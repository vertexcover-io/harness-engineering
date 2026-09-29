---
name: demo-draft
description: Test stage. Writes a short draft from the brief.
mode: inline
allowed-tools: [Bash, Read, Write]
tier: fast
inputs:
  description: The draft's name and its angle.
  schema: demo-draft.input.v1
outputs:
  description: Where the draft was written.
  schema: demo-draft.output.v1
  module: ../schemas.ts
consumes:
  - artifact: brief
produces:
  - artifact: draft
protocols: []
scopes: []
references:
  draft-format:
    path: references/draft-format.md
    description: The layout every draft follows.
---

# Demo Draft

A test stage for workflow runs. The input is `{ "name": NAME, "angle": ANGLE }`. `RUN_NAME` below
is the run's name.

## Steps

1. Read `.harness/RUN_NAME/artifacts/brief.md`.
2. Run `bun run orchestrate skill ref demo-workflows/stages/demo-draft draft-format` and follow the
   layout it prints.
3. Write the draft to `.harness/RUN_NAME/artifacts/drafts/NAME.md`.
4. Finish the node with `--artifact draft=artifacts/drafts/NAME.md`, and reply with:

   ```json
   { "draft": "artifacts/drafts/NAME.md" }
   ```
