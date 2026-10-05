# Preferences
- If the project is using TDD always prefer TDD Approach
- Ask before committing to git
- Prefer editing existing files over creating new ones. 
- Try keeping flat folder structure and lesser no of files
- Keep code simple — no over-engineering
- Comment only what the code can't say — see code-quality
- Use typescript:strict mode, and use type hints for all functions in python
- Don't name a schema that only renames a plain Zod schema (`const TimeSchema = z.iso.datetime()`, `const IdSchema = z.string().min(1)`); write the Zod call inline. A schema gets a name only when it adds a rule (a regex, a refine) or is a shared object shape. For a non-empty string, use `NonEmptyStringSchema` from `packages/sdk/src/contracts.ts`.
- Define schemas with Zod and infer their TypeScript types from the same schemas; do not duplicate schema definitions as separate types.
- Use code-quality skill for writing high quality code and try to make it functional

## Workflow
- Explore codebase before implementing changes
- Plan before coding on complex tasks
- When something goes sideways, stop and re-plan — don't keep pushing
- After finishing a task: run typecheck, tests, and lint before calling it done
- In a nested `.worktrees` checkout, `bun run lint` processes no files because `biome.json` excludes that path. Lint with a temporary Biome config that omits the exclusion.

## Style
- Prefer small, focused functions
- Use early returns over nested conditionals
- No closure factories (partial application through a closure): don't write `makeX(a, b)` that returns `{ run(c) }` with `a` and `b` captured. Write one plain function that takes every argument: `runX(a, b, c)`. An interface implementation (an object that fulfils an interface such as `ITerminal` or `IAgentProvider`) may capture its config; the rule is about partial-application helpers.

## Architecture
- There are two command-line entry points, split by who calls them:
  - The `yok` CLI (`packages/cli`) is for people: `yok run`, `yok server …`, `yok doctor`. A command that needs the server parses its flags, calls `ensureServer()`, calls one server route, and prints the reply.
  - The orchestrate commands (`packages/core/src/orchestrate.ts`, run as `yok orchestrate …`) are for skills: every action a skill takes on a run (`init`, `link-session`, `emit`, `next`, `exec`, `done`, `skill …`) is a subcommand there. It calls core directly and never goes through the server. `init` takes the run id (`--run-id`, else `$YOK_RUN_ID`); every later action names its run with `--run NAME` or `--run-id ID`, else `$YOK_RUN_ID`, and a flag always wins over the variable. The registry (`registry.json`) is shared with the server through its file lock.
  - A new action a skill needs goes in the orchestrate script, not in `yok` and not as a server route.

## Communication
Ask clarifying questions before architectural changes
Explain reasoning for non-obvious decisions

## Pipeline exemption
- The `ask before committing to git` rule does not apply to the `git-commit` and `visual-pr` stages of a `yok run` workflow. They commit, push, and open the PR without pausing. The rule still governs all other, manual git changes.
