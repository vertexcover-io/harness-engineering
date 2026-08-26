# Extension docs — extend a skill without forking it

A skill that names this file as its extension point reads `orchestrate.config.json` at the
repo root (the worktree root reads the same tracked file). If `extensions` has an entry keyed
by the skill's name, it reads that entry's file **before its first step** and follows it. A
missing config, a missing key, or an empty string means no extension — proceed normally, no
warning. A key that points to a file that does not exist: log one line naming the path and
proceed — a stale config is not a halt.

**May do:** add steps, add inputs to read, add constraints, name project skills to invoke
(via `Skill`) and where in the flow to invoke them.

**May not do:** skip or auto-approve a gate or user touchpoint, remove a `Done when` line,
change an artifact contract (file names, verdict markers, paths), or disable a step. When the
doc and the skill disagree, the skill wins.

**Writing one:** keep it short and imperative, one instruction per line, and name the step it
attaches to (e.g. "before step 1"). Example, a multi-repo project's `planning` extension:

```
Before the step-1 code sweep, invoke the `repo-lookup` skill via `Skill` with the task text.
Dispatch one Explore agent per repo it returns, in that repo's path.
```
