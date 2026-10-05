# Stack Up

**Read this when:** Step 1 brings up the stack from the config's `environments` block, and again at teardown.

## Pick the entry

`environments.entries` maps an entry name to its steps. The `environment` variable names the entry; `default`
means the one `environments.default` names. When the variable names an entry the block lacks, stop: return
`BLOCKED` with a `reason` opening `no-infra:` that names the requested entry and lists the ones that exist.

## The steps

An entry maps a step name to one command. The names below are the usual ones; an entry may leave any out or add
its own, whose name says what it does.

| Step | What it does |
|---|---|
| `stackStatus` | reads whether the stack is up, with no side effects |
| `stackUp` | creates or updates the stack |
| `stackWait` | blocks until the stack is live or failed |
| `stackUrls` | prints where each service is reached |
| `servicePort` | prints one service's port |
| `seed` | creates the accounts and records the scenarios start from |
| `auth` | gives the browser or client a signed-in session |
| `stackDown` | releases the stack |

Run them in this order: `stackStatus`, then `stackUp` only for what is not already up, then `stackWait` (with no
`stackWait`, poll `stackStatus`), then `stackUrls`, `seed` and `auth`. The base URL comes from `stackUrls` or
`servicePort` output, never from an assumed port. A step that blocks for minutes runs in the background while
you read code, and you check its output before the first walk. At teardown, `stackDown` releases only what this
attempt brought up.

A step that exits non-zero is retried once when its output says the failure was transient. A stack that still
will not come up is SKILL.md's `no-infra:` block, its `reason` quoting the command as it ran.

## Fill the placeholders

A command is a template. Fill every placeholder before running it; a brace or bracket must never reach the shell.

| Form | Meaning | Example template | Runs as |
|---|---|---|---|
| `{NAME}` | exactly one value | `up {BRANCH}` | `up feat-auth` |
| `{NAME...}` | one or more values, space separated | `up {SERVICE...}` | `up api web` |
| `[...]` inside braces | an optional part of each value | `{REPO[@REF]...}` | `api web@main` |
| `[...]` outside braces | a segment included only when the run needs what it carries; the brackets go | `up [--seed-demo]` | `up` or `up --seed-demo` |

Where the values come from:

- `BRANCH` is the input's `workspace.branch`; without a workspace, the current checkout's branch.
- Every other name is the project's. Its extension to this reference, below when it has one, says what each name
  and optional segment means and when to use it; it wins over the defaults here.
- With no extension rule for a name, choose from what this run changed: the repos in `workspace.repos`, the
  services or packages the diff touches. Leave an optional part or segment out unless the task or the diff needs
  it.

Record each command exactly as it ran, placeholders filled, in the report's environment findings.
