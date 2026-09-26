# Design spec — the contract

A run is specced when the design scout saved both `design/spec.md` and `design/<slug>/index.html`
under `.harness/<name>/`. With only one of them, the run is unspecced and this file does not apply.

`design/spec.md` holds the properties, styles, states and copy of every component the design uses.
It is the source of those values; the mock and the images are not.

`design/<slug>/index.html` is the HTML mock of the screens, with the assets it references. It
shows the layout and the order of elements on each screen, and what each state looks like.

Three things change in a specced run:

- **Planning** writes, under a step's `build to` line, one line per heading the step builds against:
  `spec: design/spec.md#<heading-slug>`. The line means the coder takes the component's properties
  and values from that heading. The step carries no style facts of its own. `verify-plan.ts` reports
  every heading no step cites.
- **Implement** opens every heading a step cites before building the step, and sets each property
  the heading lists to the value it gives.
- **Code review** spawns the Design persona. It checks the code against every heading the plan
  cites and reports each value that differs.
