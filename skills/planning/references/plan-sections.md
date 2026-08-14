# plan.md and phases/phase-N.md — the contract

Paths: `.harness/<name>/plan.md` · `.harness/<name>/phases/phase-N.md`.

Both files are agent-facing. `plan.html` is the human review surface; these are extracted from
it and are never rendered to a person. Examples below use a neutral domain, user auth,
unrelated to the feature being planned.

## Who reads them

| Consumer | Reads | Uses it for |
|---|---|---|
| `orchestrate` | `plan.md`, the `## Phases` section | parses the digraph, dispatches coder waves |
| a coder | one `phases/phase-N.md`, plus `plan.md` | what it builds, and the scenarios that prove it |
| `quality-gate` | `plan.md` and every phase file | resolves scenario ids against the matrix |
| `code-review`, spec persona | `design.md` and `plan.md` | the intent to review the diff against |

A reviewer can open these directly. They are handed `plan.html` first.

## Fixed format — do not vary

Five things are matched by name or by shape. Rename or reshape one, and a downstream skill
fails without saying why.

| Item | Read by | Rule |
|---|---|---|
| the `## Phases` heading | orchestrate | exact text |
| the digraph inside it | orchestrate | `digraph phases { … }`, one node per phase id, `pN -> pM` edges |
| the `## Acceptance` heading | the coder | exact text |
| `# Phase N: <title>` and `Depends on:` | the coder | the first two lines of every phase file |
| scenario ids | quality-gate | the format in `test-scenarios.md`, unique across the whole plan |

Everything else is prose. The rules below govern it.

## Writing for a coder

**The coder sees one phase file and `plan.md`. Nothing else.** It cannot open a sibling phase
file. Never write "as in phase 2" or "the helper phase 1 builds" — name the thing, and put its
signature in the index.

**Write one reading.** A person asks when a sentence is ambiguous. A coder picks a reading and
builds it. A sentence carrying two meanings is a defect, not a style preference. Choose the
meaning and write that one.

**Every line competes with code.** The phase file loads into the coder's context beside the
files it must read. A line that does not change what the coder builds takes attention it needs
elsewhere.

`../_shared/writing-style.md` governs both files — for precision, not for readability.

## File references

Write them as `src/services/user.ts:34 — createUser, the insert path`. The path leads. The
clause names what is there, so the coder does not open the file to find out. Repo-relative
always.

## Sections are available, not required

Include a section when it has content that meets its trigger. Omit it otherwise. An absent
section costs nothing. A thin one costs context, and it states "considered, nothing found" —
a claim you did not mean to make.

The floor is real: a small change can be phases and their scenarios, and nothing else. That is
a complete plan.

| plan.md section | Include when |
|---|---|
| `## Inputs` | upstream documents exist — name them, plus one line on what this plan adds |
| `## Requirements` | there is no requirements document, so planning established the ids itself |
| `## Design corrections` | the code contradicted an input: what was assumed, what the code shows, what changes |
| `## Phases` | always — capability title, repos touched, builds/needs, *why the cut is there*, and the digraph |
| `## Global constraints` | something binds every phase and is invisible to one built in isolation — fixed values, verbatim copy, platform limits. A value used in one phase belongs in that step. |
| `## Signature index` | a name is defined in one phase and used in another |
| `## Blockers in existing code` | existing code must be repaired or worked around to build **or test** this |
| `## Test Matrix` | requirements exist — one row per requirement |
| `## Acceptance` | something is provable only after every phase lands |
| `## Deferred` | work was deliberately excluded, the user chose to defer an open question, or `--auto` deferred one (marked `auto`) |

No status fields — progress derives from git and the digraph. No file inventory, no patterns
table, no reuse-verdict table: those belong in the steps they govern.

### The phase digraph

One node per phase id. An edge means "must land first". orchestrate reads this to compute which
phases are ready in each wave.

    digraph phases {
      p1 [label="1: <capability>"]
      p2 [label="2: <capability>"]
      p1 -> p2
    }

### The signature index

Flat, one line per new or changed signature, grouped by phase. It exists because the coder
cannot open the phase file that defines the name. Duplication is the point of an index.

    // phase 1
    register(email, password) → User | DuplicateError
    POST /register → 201 | 409 | 422

    // phase 2
    issueToken(user) → Session
    Session = { token: string, expiresAt: Date }

It introduces nothing. Every entry is defined by a step. A name here that no step builds is a
finding.

### Blockers

Only what must be repaired or worked around to build this — problems that block the work, or
make the new code hard to write, test, or understand. Each one gets a phase.

**A unit no test can construct is a blocker, even when the feature builds fine around it.** The
symptom shows up in the Test Matrix, not in the steps: rows climb to `e2e` because
nothing lower can reach the behavior. Name the shape that forces the climb, quote it, and give a
phase the step that opens it up. `test-scenarios.md`'s red flag says when to go looking.

Pre-existing problems in a file you happen to be touching are out of scope; they are
`tech-debt-finder`'s job. A long list dilutes the entries that actually block. If a row's
resolution would be "leave the code as is", it is not a blocker — delete the row.

Quote the code. The coder matches the quoted text to find the place; four lines locate it, and
a paragraph describing it does not.

## phase-N.md

Header: `# Phase N: <the capability title>`, then a `Depends on:` line.

| Section | Answers only | Must not contain |
|---|---|---|
| `## Goal` | why this phase exists, what it unlocks — folds into the header when the title already says it | file lists, steps |
| `## Interfaces` | what this phase consumes from earlier phases and produces for later ones — **names from the signature index, never re-typed** | rationale, steps |
| `## Implementation` | how, as ordered steps | scenario prose, done-criteria |
| `## Test Scenarios` | the behavior that proves it, grouped `### Unit` · `### Integration` · `### E2E` · `### QA Agent` — only the subsections this phase has | implementation detail, cross-phase flows |
| `## Commit` | the message | — |

`## Interfaces` appears only where a seam exists. There is no Done-When section — the scenarios
are the definition of done. Content restating another section is cut.

## Implementation steps

A step opens with a bold action title naming its file or files. What follows depends on what the
step is; the shape serves the content rather than a template.

### What earns a step

A step carries a new function's design, a new file's location, a change to an existing type or
signature, or an algorithm whose correctness is not obvious. It states where the code goes, what
its contract is, and — where the location or shape had a plausible alternative — what that was
and why not.

The alternative clause is one sentence when there is one, and absent when there is not. Name the
rejected alternative. Without it the coder re-decides alone, and can pick the option you ruled
out.

A step that is only "modify X to do Y" is mechanical — the coder sees it on opening the file.
Reduce it to a one-line note, or cut it. Steps are not a change list.

### Creating a new file — contract, then logic

- **Contract** — the signature or data shape it introduces, one line, mirrored in the index.
- **Logic** — the ordered operations *including the branch and the error path*: normalize → look
  up → reject duplicate → hash → persist → return without the secret field.
- **Placement** — the directory, and why there rather than the obvious alternative, when there
  was one.

### Changing existing code — quote, then show

Quote when the coder would otherwise build against the wrong current state: a modification
rather than an addition, a defect that lives in the code, something non-obvious it must
preserve, or a surrounding shape the new code has to match.

Do not quote a pattern being imitated rather than edited — name it (`bull-queue.ts:1678 —
createFlow, the parent-plus-children builder`) and let the coder read it whole. Do not quote when
the prose already determines the change, or when orienting would take forty lines: a quote that
long claims the change is self-contained when it is not.

In the before-block, elide to the lines that matter. In the after-block, show only the changed
lines.

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
   error cannot tell which column collided.
```

**Never describe a call site in prose where the code would fit.** "Follows the pattern at
`:1618`" sends the coder off to read and interpret; the four lines say it, and they show the size
of the change at the same time.

### Traps

Some code looks safe to remove and is not: a guard that looks redundant, a flag that looks
vestigial. Give each one line naming what breaks if the coder removes it. It is not a step; it
is a fence.

### Test-file steps

Not a step. The scenarios define what the tests assert. Where the *strategy* is a real
decision — what is faked, what is driven by data — it belongs in the matrix's strategy column.
