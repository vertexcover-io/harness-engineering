# When planning routes straight to `implement`

The planning skill's own gate may hand genuinely atomic work to the `implement` skill. It then
writes no `plan.html` and no phase files.

That is a valid outcome, not a stage failure. Never pre-empt the gate by making the call yourself.

When it happens:

1. Append the planning `end` event with `result: "ok"`, and record the route in its report.
2. **Skip stages 3 and 4.** There is no phase graph to dispatch from and no slice to review.
   Set both dashboard nodes to `skipped`, and append an `end` with `result: "skipped"` for each.
3. Invoke `implement` via `Skill` with the recon findings planning handed back.
4. Go to stage 5.
5. Stage 6 runs unchanged.

The coder gate has no phases to walk, so it passes on the `skipped` result. The verify gate still
requires `verification/proof-report.html`.
