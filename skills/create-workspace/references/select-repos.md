# Select repos

Pick which repos from the `workspace` script's `info` go into a multi-repo workspace. You have
the input's `request` (what the run should do) and the `packages` list, where each entry has a
`name`, a `path` and sometimes a `description`.

- **No request:** pick every repo, and say that you did because there was no request to judge by.
- **Pick a repo** when the request names it, names its path, or describes work its `description`
  covers.
- **Borderline repo:** include it. An extra repo costs one setup run; a missing one stops a later
  stage until someone adds it.
- **No repo clearly matches:** pick all of them, and say so.

Pass the picked names to the `workspace` script's `create` as `--repos NAME1,NAME2`, so the
script runs with `create SPEC_NAME --run SPEC_NAME --repos NAME1,NAME2`.

A later stage that finds it needs another repo adds it to the existing workspace by running the
`workspace` script with `add SPEC_NAME --repos NAME --run SPEC_NAME`.
