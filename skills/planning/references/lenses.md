# Lenses

Angles to think from. Consider each one against the work in front of you.

Walk the list twice: in step 2 against the problem, to find questions the user did not ask;
in step 3 against the approach you chose, to find where it breaks.

Most lenses will not fire. Skip those, with no note. When one does fire, its finding becomes a
decision, a question to the user, a Test Matrix row or scenario, a `## Blockers in existing
code` entry, or a named risk.

| Lens | Fires when | Ask |
|---|---|---|
| Reuse | the sweep found code that already does part of this | does it apply here, and what does using it cost? |
| Abstraction | the same shape exists in two or more places, or this change adds another copy | should one thing serve them all, and does that pass `code-quality`'s extraction gate? |
| Testability | you cannot name the function a unit test would call to prove the core behavior | what shape would make that possible, and which phase builds it? |
| Load | the solution adds a read path or a write path | what is the real expected volume, and what breaks at ten times that? |
| Security & abuse | the solution adds an input, an endpoint, or a trust decision | who abuses this, and what does the boundary check? |
| Failure | the solution calls something that can fail on its own | what happens when it is down, when it times out, and when it half-completes? |
| Concurrency | two actors can write the same state | what happens with two writers, a read during a write, and an actor holding a stale copy? |
| Maintainer | the design adds a concept, a name, or an indirection the codebase does not have | what does the next reader need in order to change this safely? |
| Adjacent systems | the change alters a contract another system depends on | what did we assume about that system that could change? |
| Migration | the change alters stored data, or a contract with live callers | how do existing records and in-flight requests move to the new behavior? |
