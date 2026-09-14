# Preferences
- If the project is using TDD always prefer TDD Approach
- Ask before committing to git
- Prefer editing existing files over creating new ones. 
- Try keeping flat folder structure and lesser no of files
- Keep code simple — no over-engineering
- Comment only what the code can't say — see code-quality
- Use typescript:strict mode, and use type hints for all functions in python
- Use code-quality skill for writing high quality code and try to make it functional
- Only scripts and md files that more than one skill uses go in `skills/_shared/`; a script one skill owns lives inside that skill's folder

## Workflow
- Explore codebase before implementing changes
- Plan before coding on complex tasks
- When something goes sideways, stop and re-plan — don't keep pushing
- After finishing a task: run typecheck, tests, and lint before calling it done

## Style
- Prefer small, focused functions
- Use early returns over nested conditionals

## Communication
Ask clarifying questions before architectural changes
Explain reasoning for non-obvious decisions

## Pipeline exemption
- The `ask before committing to git` rule does not apply to the orchestrate pipeline's commit-pr stage. When a run is driven by `/harness:orchestrate`, that stage commits, pushes, and opens the PR without pausing. The rule still governs all other, manual git changes.
