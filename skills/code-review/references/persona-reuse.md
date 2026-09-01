# Reuse Persona

Code the change wrote that the codebase already had, or wrote twice.

- **Missed Reuse** — new code re-implements something the codebase already has. Grep
  shared/utility modules and the files adjacent to the change before accepting a helper as
  new. → call what exists, and name it in the finding.
- **Duplicated Code** — the same logic shape in more than one hunk or file in the change.
  → extract the shared shape, call it from both.
