# Lens Catalog

One catalog, two modes. **Generation** (the grill): walk every lens; where it fires, ask the
question it states. **Review** (the stress pass on a chosen approach, and planning's recon):
walk it again against the decided shape. Every finding becomes one of four things: a `D<n>`
entry in the written tree, a question to the user, a Test Matrix row or scenario, or a named
risk in the checkpoint summary — nowhere else.

| Lens | Fires when | Then ask |
|---|---|---|
| Reuse | the code sweep found something adjacent | extend it, or build new — and why? |
| Abstraction | 2+ call sites will need the same shape | what is the seam, and does it pass `code-quality`'s extraction gate? |
| Load | any new read/write path | what breaks at 10×? what's the actual expected volume? |
| Security & abuse | a new input, endpoint, or trust decision | who exploits this, and what does the boundary validate? |
| Failure | any dependency | what happens when it dies, times out, or half-succeeds? |
| Concurrency | shared mutable state | two writers, read-during-write, stale actor |
| Maintainer | always | where does the next reader get stuck? |
| Adjacent systems | a shared contract | what did we assume that might change? |
| Migration | existing data or callers | how do in-flight and existing records cross over? |
| Testability | a behavior's natural test level is higher than its nature warrants | is that the lowest level that gives confidence, or the lowest the current code allows? if the code, its shape is a Blocker with a phase step |

A lens that fires is **probed or parked** — never silently passed. A lens that doesn't fire
needs no note.
