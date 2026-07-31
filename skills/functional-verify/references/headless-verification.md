# Headless Verification

**Read this when:** the feature has no UI, or a behaviour within it has no screen to drive. Step 2's browser craft
does not apply; the evidentiary bar does. A headless run proves the same things a filmed one proves — that the code
under test actually ran, and that the state it was supposed to change actually changed.

## The shape of a headless walk

A walk is a sequence of real calls against the running service, not a single request. Four parts, every one of them
captured:

1. **Preconditions** — the records the walk needs, built through the product's own APIs where they exist. Record
   what you created and its ids; they belong in the scenario's capture so a reader can tell your data from the
   database's.
2. **The trigger** — the real entry point a user or an integration would hit. `curl -w '\n%{http_code}'`, the exact
   command, status and body.
3. **The read-back** — query the datastore for what should have changed, and quote the fields. A 200 is not
   evidence that anything was written.
4. **The side effects** — the queue entry, the email at its sink, the webhook body, the second document the first
   one spawned. A walk that stops at the primary write leaves the interesting half unproven.

## Prove the code under test ran

The failure mode unique to headless work is a walk that passes without ever reaching the change. Guard against it
with at least one of these per scenario, and say in the report which one you used:

- **A branch trace.** Start the service with its debug channel on and quote the line naming the function under
  test. The absence of that line is a failing scenario, not a quiet pass.
- **A discriminating value.** Seed the precondition so the expected output cannot be produced any other way — a
  value nothing else in the system would write. Then finding it proves the path.
- **A negative control.** Run the same walk with the precondition removed and show the outcome differs. Same value
  both ways means your walk proves nothing about the feature.

**A read-back that would have passed before the change is not evidence.** Ask that question of every assertion you
write; it is the headless equivalent of a frame that shows the wrong screen.

## Traps

- **A 200 that did nothing.** Fire-and-forget handlers, swallowed errors, and after-hooks that catch and continue
  all return success. Read the log and the datastore, never the status alone.
- **Reads that lie.** A service may recompute, cache, or normalise on read — the row you fetch through the API can
  differ from the row on disk, in both directions. When the two disagree, capture both and say which one the
  feature is about.
- **Writes the service can't see.** Inserting straight into the datastore bypasses whatever index, cache or search
  layer the service reads through, so the record exists and the product cannot find it. Prefer the service's own
  create path for anything the feature will later read.
- **Gates before the code under test.** Entitlements, feature flags, allow-lists, and status preconditions sit in
  front of most interesting paths. When a walk produces nothing, read the gate before concluding the feature is
  unreachable — that reading is what separates a real gap from an early stop (Step 4).
- **Shared datastores.** Other worktrees are usually on the same database. Scope every fixture uniquely, and count
  the pre-existing rows before and after if the scenario asserts an absence.

## Evidence in the report

Frames and videos do not exist here, so the exchange is the whole evidence and a headless scenario carries its
weight in `proofs[]` — one entry per mechanism, each holding the **verbatim exchange** inline, so a dev re-runs the
call from the entry alone. Everything else about grading, coverage, gaps and the derived verdict is unchanged:
see `writing-the-report.md`.
