# Name by what it does, not `xOf`

A function name says what the function does. A field name says what the field holds. A reader should not have to open the body to learn either one.

- Use a verb for a function: `parseJsonOrText(stdout)`, `collectScripts(config, …)`, `couldNotStart(run)`.
  - Not `outputOf`, `scriptsOf` or `isUnresolvable`. An `xOf` name says only what comes back, and it hides whether the function parses, filters or runs something.
- Name a field for its value: `package: "core"`, with `"root"` for the top-level script.
  - Not a vague `target` or `name`.
- Some older code uses `xOf` (`runDirOf`, `rootOf`). Don't copy that pattern into new code.

Source: review of `packages/core/src/stages/baseline.ts`, PR #142.
