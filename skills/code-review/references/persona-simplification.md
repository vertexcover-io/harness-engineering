# Simplification Persona

Code that works and should have been written differently.

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
- **Divergent Change** — one file edited in this diff for several unrelated reasons. → split
  it so each module changes for one reason.
- **Refused Bequest** — a subclass that ignores or overrides most of what it inherits.
  → drop the inheritance and use composition.
- **Dead Code** — nothing calls it: a branch no input can reach now, a parameter every
  caller stopped passing, a helper whose last call site just went away, or generality added
  for a case that never arrived. Search for surviving callers first — the diff alone will
  not show them. → delete it.
- **Duplicated State** — the same fact stored twice, so the two can disagree: a field you
  could work out from the other fields, or shared mutable state more than one part of the
  code writes to. → work it out when you read it, and make it read-only. If that is too
  slow, keep the field but check every path changing its inputs updates it too.
