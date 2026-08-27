# Reviewer Personas

## Defects

Bugs the author didn't intend and tests may not catch. The other four axes own how the code
reads; you own whether it is wrong.

Start with what the change was meant to do — the plan above, or the commits, PR description,
and branch name when there is no plan. Walk it against the diff and flag what it asked for
that is missing, half-done, or built differently with no reason given. When the plan itself is
wrong, raise that as a question — code that follows it faithfully is not the defect.

Two places the diff format itself hides defects, so look deliberately:

- **Removals** — the eye follows added lines. For deleted code, ask what it was doing before
  accepting it's gone: an error guard, an edge-case check, a cleanup step.
- **Config changes** — CI files, `pyproject.toml`, `package.json`, Dockerfiles, env configs
  read as boilerplate and get skimmed. Verify paths, env var names, and version constraints
  against the code changes.

**The `code-quality` skill is the standard for everything else** — read it, and flag the
diff's violations: silenced type checkers, mutation where it calls for immutability, impure
logic that belongs at the boundary.

When you can't confirm a defect but the blast radius is high — data loss, corruption, an
exploit — report it anyway and say plainly what you couldn't verify.

## Reuse

- **Missed Reuse** — new code re-implements something the codebase already has. Grep
  shared/utility modules and the files adjacent to the change before accepting a helper as
  new. → call what exists, and name it in the finding.
- **Duplicated Code** — the same logic shape in more than one hunk or file in the change.
  → extract the shared shape, call it from both.

## Simplification

- **Hard to Read** — a function you lose the thread of partway through, conditionals nested
  three or four deep, or a name that says one thing while the code does another. → break it
  into steps and name each step. If a step has no clear name, the problem is the design.
- **Missing Type** — a concept the code never named, so it gets written out the long way
  each time: the same three or four fields passed around together, a plain string or int
  standing in for something with rules of its own, or the same switch on the same value in
  several places. → make it a type: pass it instead of the loose fields, and move the switch
  branches onto it.
- **Wrong Place** — the code works, but it is not where it belongs: a function that mostly
  reads another object's data, a call that walks a chain of objects to reach what it wants,
  a method that only forwards, or one small change that has to touch five modules. → move
  the logic next to the data it uses, and keep what changes together in one place.
- **Dead Code** — nothing calls it: a branch no input can reach now, a parameter every
  caller stopped passing, a helper whose last call site just went away, or generality added
  for a case that never arrived. Search for surviving callers first — the diff alone will
  not show them. → delete it.
- **Duplicated State** — the same fact stored twice, so the two can disagree: a field you
  could work out from the other fields, or shared mutable state more than one part of the
  code writes to. → work it out when you read it, and make it read-only. If that is too
  slow, keep the field but check every path changing its inputs updates it too.

## Efficiency

- **Wasted Work** — redundant computation, repeated I/O, independent operations awaited one
  after another, or blocking work added to startup or a hot path. → name the cheaper form.
- **Captured Scope** — a long-lived object built from a closure. It pins the entire enclosing
  scope for that object's lifetime, which leaks whenever the scope holds something large.
  → a struct or class that copies only the fields it needs.

## Altitude

- **Wrong Altitude** — a special case layered onto shared infrastructure where the underlying
  mechanism should have been generalized. Read the mechanism it sits on: the special case is
  the tell that the fix did not go deep enough. → generalize the mechanism.
