# Dispatch preamble

Name the resolved skill, pass this run's variables, say what to return, and stop.
If a dispatch needs another procedure, put it in the owning skill.

Replace `[PREAMBLE]` in the coder, verify, quality-gate and retro prompts with this block verbatim:

```text
You are working in the worktree at <WORKTREE_PATH>.
Your working directory is <WORKTREE_PATH>.

What this repo builds, lints and tests with is declared in orchestrate.config.json at the repo
root. Read it and use those exact invocations — do not rediscover the runner or guess a
file-filter flag. Separately, the results in <HARNESS_DIR>/baseline.json are what "no new
failures" is measured against; a suite that was already red is not your regression.
```

| In the dispatch | In the skill |
|---|---|
| Worktree, spec, phase, diff range | How to implement or review |
| Artifact paths | Artifact content and gate |
| Resolved skill and model | Procedure and documentation style |
| What to return | How to do the work |
