# Select repos

Pick which repos from `bun run orchestrate workspace info` go into a multi-repo workspace.

You have the input's `request` (what the run should do) and the `packages` list, where each entry
has a `name`, a `path` and sometimes a `description`.

- **No request:** pick every repo, and say that you did because there was no request to judge by.
- **Pick a repo** when the request names it, names its path, or describes work its `description`
  covers.
- **Borderline repo:** include it. An extra repo costs one setup run; a missing one stops a later
  stage until someone adds it.
- **No repo clearly matches:** pick all of them, and say so.

Pass the picked names to `bun run orchestrate workspace create SPEC_NAME --run SPEC_NAME` as
`--repos NAME1,NAME2`.

A later stage that finds it needs another repo adds it to the existing workspace with
`bun run orchestrate workspace add SPEC_NAME --repos NAME --run SPEC_NAME`.
