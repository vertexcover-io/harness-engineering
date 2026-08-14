# plan.md and phases/phase-N.md — the writing contract

Paths: `.harness/<name>/plan.md` · `.harness/<name>/phases/phase-N.md`. Examples use a neutral
domain (user auth) unrelated to the feature being planned.

**File references, everywhere in both documents:** `src/services/user.ts:34 — createUser, the
insert path`. The path leads so click-detection resolves it; the clause names what's there so
the reader doesn't open the file to find out. Repo-relative always.

## Sections are available, not required

Include a section when it has content meeting its trigger; omit it otherwise. An absent section
reads as "nothing to say here", which is accurate and costs nothing. A present-but-thin one
reads as a filled template and teaches the reader to skim.

The floor is real: a small change can be phases and their scenarios, and nothing else. That is
a complete plan.

| plan.md section | Include when |
|---|---|
| `## Inputs` | upstream documents exist — name them, plus one line on what this plan adds |
| `## Requirements` | there is no requirements document, so planning established the ids itself |
| `## Design corrections` | recon contradicted an input: what was assumed, what the code shows, what changes |
| `## Phases` | always — capability title, repos touched, builds/needs, *why the cut is there*, and the DOT digraph |
| `## Global constraints` | something binds every phase and is invisible to one built in isolation — fixed values, verbatim copy, platform limits. A value used in one phase belongs in that step. |
| `## Signature index` | a name is defined in one phase and used in another |
| `## Blockers in existing code` | existing code must be repaired or worked around to build **or test** this |
| `## Test Matrix` | requirements exist — one row per requirement |
| `## Acceptance` | something is provable only after every phase lands |
| `## Deferred` | work was deliberately excluded, the user chose to defer an open question, or `--auto` deferred one (marked `auto`) |

No status fields — progress derives from git and the DAG. No file inventory, no patterns table,
no reuse-verdict table: those belong in the steps they govern.

### The phase digraph

Inside `## Phases`, one DOT digraph names the build order — orchestrate dispatches coder waves
from it. One node per phase id; an edge means "must land first".

    digraph phases {
      p1 [label="1: <capability>"]
      p2 [label="2: <capability>"]
      p1 -> p2
    }

### The signature index

Flat, one line per new or changed signature, grouped by phase. It exists for one reader — a
coder building a later phase who cannot see the earlier phase's file and needs to check whether
the function is `resolveColumns` or `getColumns`. Duplication is the point of an index.

    // phase 1
    register(email, password) → User | DuplicateError
    POST /register → 201 | 409 | 422

    // phase 2
    issueToken(user) → Session
    Session = { token: string, expiresAt: Date }

It introduces nothing: every entry is defined by a step. A name here that no step builds is a
finding.

### Blockers

Only what must be repaired or worked around to build this — problems that block the work, or
make the new code hard to write, test, or understand. Each gets a phase.

**A unit no test can construct is a blocker, even when the feature builds fine around it.** The
symptom shows up in the Test Matrix, not in the steps: rows climb to `e2e (system)` because
nothing lower can reach the behavior. Name the shape that forces the climb, quote it, and give a
phase the step that opens it up. `phase-design.md`'s red flag says when to go looking.

Pre-existing problems in a file you happen to be touching are out of scope; they are
`tech-debt-finder`'s job, and listing them trains the reader to skim the ones that matter.
If a row's resolution would be "leave the code as is", the problem is not a blocker — delete
the row.

Quote the code. A blocker described in prose is a claim the reader has to verify; the four
lines that show it are the argument.

## phase-N.md

Header: `# Phase N: <the capability title>` + a `Depends on:` line.

| Section | Answers only | Must not contain |
|---|---|---|
| `## Goal` | why this phase exists, what it unlocks — folds into the header when the title already says it | file lists, steps |
| `## Interfaces` | what this phase consumes from earlier phases and produces for later ones — **names from the signature index, never re-typed** | rationale, steps |
| `## Implementation` | how, as ordered steps | scenario prose, done-criteria |
| `## Test Scenarios` | the behavior that proves it — only the subsections this phase has | implementation detail, cross-phase flows |
| `## Commit` | the message | — |

`## Interfaces` appears only where a seam exists. No Done-When section — the scenarios are the
definition of done. Content restating another section is cut.

## Implementation steps

A step opens with a bold action title naming its file(s). What follows depends on what the step
is; the shape serves the content rather than a template.

### What earns a step

A step carries a new function's design, a new file's location, a change to an existing type or
signature, or an algorithm whose correctness isn't obvious. It states where the code goes, what
its contract is, and — where the location or shape had a plausible alternative — what that was
and why not.

The alternative clause is one sentence when there is one and absent when there isn't. Name the
rejected alternative so a reviewer can challenge the choice — a reader can only push back on a
choice they can see was a choice.

A step that is only "modify X to do Y" is mechanical — the coder will see it on opening the
file. Reduce it to a one-line note, or cut it. Steps are not a change list.

### Creating a new file — contract, then logic

- **Contract** — the signature or data shape it introduces, one line, mirrored in the index.
- **Logic** — the ordered operations *including the branch and error path*: normalize → look up
  → reject duplicate → hash → persist → return without the secret field.
- **Placement** — the directory and why there rather than the obvious alternative, when there
  was one.

### Changing existing code — quote, then show

Quote when the reader would otherwise mis-picture the current state: a modification rather than
an addition, a defect that lives in the code, something non-obvious that must be preserved, or
a surrounding shape the new code has to match.

Don't quote a pattern being imitated rather than edited — name it (`bull-queue.ts:1678 —
createFlow, the parent-plus-children builder`) and let the coder read it whole. Don't quote when
the prose already determines the change, or when orienting would take forty lines: a quote that
long is a lie about how self-contained the change is.

In the before-block, elide to the lines that matter. In the after-block, show only the changed
lines. An after-block as long as the before-block is a diff pretending to be an explanation.

```markdown
1. **Modify `src/services/user.ts:31 — createUser, the insert path`** — reject duplicates

   Today:
   ```ts
   async function createUser(email: string, pw: string): Promise<User> {
     const hash = await bcrypt.hash(pw, 12)
     return db.users.insert({ email, hash })
   }
   ```
   Add a `findByEmail` lookup before hashing; when it returns a row, throw `DuplicateError(email)`
   instead of inserting:
   ```ts
     if (await findByEmail(email)) throw new DuplicateError(email)
   ```
   The happy path is unchanged. `findByEmail` rather than a unique-index catch: the constraint
   error can't distinguish which column collided.
```

**Never describe a call site in prose where the code would fit.** "Follows the pattern at
`:1618`" is a claim the reader has to go verify; the four lines are the proof, and they show the
size of the change at the same time.

### Traps

Some code looks safe to undo but is not: a guard that looks redundant, a flag that looks
vestigial. Give each one line naming what breaks if the coder removes it. It isn't a step;
it's a fence.

### Test-file steps

Not a step. The scenarios define what the tests assert. Where the *strategy* is a real
decision — what's faked, what's driven by data — it belongs in the matrix's strategy column.
