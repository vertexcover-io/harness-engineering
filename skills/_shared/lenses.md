# Lens Catalog

One catalog, two modes. **Generation** (the grill): walk every lens; where it fires, ask the
question it states. **Review** (the stress pass on a chosen approach, and planning's recon):
walk it again against the decided shape; every finding lands in the consuming doc's own
sections — for a design: Requirements, Edge Cases, Risks, or a Decision; for a plan: a
Codebase Context entry, a Tech Debt disposition, a matrix row, or a question to the user —
nowhere else.

| Lens | Fires when | Then ask |
|---|---|---|
| Reuse | the dossier found something adjacent | extend it, or build new — and why? |
| Abstraction | 2+ call sites will need the same shape | what is the seam, and does it pass `code-quality`'s extraction gate? |
| Load | any new read/write path | what breaks at 10×? what's the actual expected volume? |
| Security & abuse | a new input, endpoint, or trust decision | who exploits this, and what does the boundary validate? |
| Failure | any dependency | what happens when it dies, times out, or half-succeeds? |
| Concurrency | shared mutable state | two writers, read-during-write, stale actor |
| Maintainer | always | where does the next reader get stuck? |
| Adjacent systems | a shared contract | what did we assume that might change? |
| Migration | existing data or callers | how do in-flight and existing records cross over? |

A lens that fires is **probed or parked** — never silently passed. A lens that doesn't fire
needs no note.
