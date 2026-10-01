# Coverage map and lenses

## Coverage map — what the design must know

Mark each area **clear**, **partial** or **missing** for this task. Only a partial or missing
area whose answer would change what gets built becomes a decision node. Rank nodes by impact
times uncertainty: a wrong guess that forces a rebuild outranks one that changes a label.

| Area | Clear when you can state |
|---|---|
| Purpose | why the task exists, and what happens if it is never built |
| Actors | who triggers it, who sees the result, who is affected without asking for it |
| Outcome | what is true after it ships, in terms the actor would use |
| Scope | what is in, and what is explicitly out |
| Behavior | what the system does on the main path, step by step |
| Data | the entities, their fields, who owns each, and how long it is kept |
| Interface | the surface the actor touches: a screen, a command, an API, an event |
| Integration | every outside system it calls or is called by, and the contract with each |
| Edge cases | empty, duplicate, too large, out of order, partial input |
| Failure | what happens when each dependency is down, slow, or half-completes |
| Quality bars | the volume, latency, security and privacy limits it must meet |
| Terms | one name per concept, matching the name the code already uses |
| Done | how the user will judge that it works |

## Lenses — where an approach breaks

Walk the list twice: against the problem in step 2, to find forks the user did not raise, and
against the chosen approach in step 4, to find where it breaks. Most lenses will not fire; skip
those with no note.

| Lens | Fires when | Ask |
|---|---|---|
| Reuse | the sweep found code that already does part of this | does it apply here, and what does using it cost? |
| Abstraction | the same shape exists in two or more places, or this adds another copy | should one thing serve them all? |
| Boundaries | the design adds a component | can you say what it does, how it is used and what it depends on, without reading its insides? |
| Load | the design adds a read or write path | what is the real volume, and what breaks at ten times that? |
| Security | the design adds an input, an endpoint or a trust decision | who abuses this, and what does the boundary check? |
| Failure | the design calls something that can fail on its own | what happens when it is down, when it times out, and when it half-completes? |
| Concurrency | two actors can write the same state | what happens with two writers, a read during a write, a stale copy? |
| Migration | the change alters stored data or a contract with live callers | how do existing records and in-flight requests move over? |
| Adjacent systems | the change alters a contract another system depends on | what did we assume about that system that could change? |
| Testability | you cannot name the function a test would call to prove the core behavior | what shape would make that possible? |
| Maintainer | the design adds a concept, name or indirection the code does not have | what does the next reader need to change this safely? |
