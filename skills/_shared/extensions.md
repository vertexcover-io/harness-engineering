# Extension docs — extend a skill without forking it

A skill that names this file as its extension point reads `orchestrate.config.json` at the
repo root (the worktree root reads the same tracked file). If `extensions` has an entry keyed
by the skill's name, it reads that entry's file **before its first step** and follows it. A
missing config, a missing key, or an empty string means no extension — proceed normally, no
warning. A key that points to a file that does not exist: log one line naming the path and
proceed — a stale config is not a halt.

The doc cannot skip a gate or user touchpoint, or change an artifact contract (file names, paths,
verdict markers).
