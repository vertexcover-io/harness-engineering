# The Ledger

Every stage writes what happened to one append-only file. One script folds that file into a summary. Gates read the summary.

```
.harness/<SPEC_NAME>/events.jsonl    one event per line. Every stage appends. Nobody edits.
.harness/<SPEC_NAME>/state.json      computed. One script writes it. Never edit it by hand.
```

## Commands

Set these once, in stage 0:

```bash
export LEDGER_DIR=".harness/<SPEC_NAME>"
LEDGER="node ${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/skills/_shared/ledger.mjs"
```

| Command | Does |
|---------|------|
| `$LEDGER add` | reads one event per line from standard input, appends, refolds |
| `$LEDGER state` | prints the summary |
| `$LEDGER state --refresh` | reads the session transcripts and fills in tokens and cost |
| `$LEDGER state --assert <stage>` | exits 0, or exits 1 and prints one word |

**Always append through a here-document.** The quoted delimiter turns off shell expansion, so quote marks, back ticks and line breaks inside the prose all survive:

```bash
$LEDGER add <<'JSON'
{"stage":"review","type":"problem","id":"R1","kind":"defect","level":"high",
 "where":"src/auth.ts:42","detail":"token compared with `==` — this lets \"1\" equal 1"}
JSON
```

`add` never fails its caller. A bad event goes to standard error and the command still exits 0. Only `--assert` may fail.

## The envelope

Every event carries a `type`. Two more fields say what it applies to:

| Fields present | Applies to |
|----------------|-----------|
| neither | the whole run |
| `stage` | that stage |
| `stage` and `phase` | one coder phase |

`ts` is stamped for you when you leave it out.

## The ten event types

| Type | Append it when |
|------|----------------|
| `start` | a run, a stage, or a phase begins |
| `end` | one of those finishes — carries `result` |
| `check` | a measurement was taken — carries a `proof` path |
| `artifact` | a document, a commit or a pull request was produced |
| `problem` | a defect, a bug or a broken library was found |
| `resolution` | a problem was settled — carries `how` |
| `decision` | a library or an approach was picked over others |
| `question` | the run stopped and waited for the user |
| `answer` | the user replied |
| `package` | one buildable package and its commands, copied from `harness.json` |

## The fields that carry the variety

| Field | On | Values |
|-------|-----|--------|
| `kind` | `check` | `tests` · `lint` · `types` · `coverage` · `gate` |
| `kind` | `artifact` | `design` · `plan` · `review` · `proof` · `commit` · `pr` |
| `kind` | `problem` | `defect` · `library` · `lesson` |
| `kind` | `decision` | `library` · `approach` |
| `result` | `end` | `ok` · `failed` · `blocked` · `skipped` |
| `how` | `resolution` | `fixed` · `accepted` · `duplicate` |
| `level` | `problem` | `high` · `medium` · `low` |

Three more matter. `proof` holds the path to the file the checker itself wrote. `token` holds the six-character word that names a subagent. `id` names one problem, and nobody renumbers it.

`blocked` is not `failed`. A stack that will not start proved nothing either way. Say so.

## Worked examples

```jsonl
{"type":"start","spec":"add-user-auth","branch":"feat/add-user-auth","base":"3a74439","auto":false,"harness":"1.25.0"}
{"type":"package","name":"web","path":"packages/web","runner":"vitest","test_all":"pnpm --filter web test"}
{"stage":"setup","type":"check","kind":"tests","package":"web","total":412,"failed":0,"proof":"setup/web-tests.json"}
{"stage":"planning","type":"question","topic":"session storage: redis or postgres"}
{"stage":"planning","type":"answer"}
{"stage":"planning","type":"decision","kind":"library","picked":"lucia-auth","over":["next-auth"],"why":"next-auth needs a route handler we cannot host"}
{"stage":"planning","type":"artifact","kind":"plan","path":"plan.html"}
{"stage":"coder","phase":3,"type":"start","token":"7f3a9c"}
{"stage":"coder","phase":3,"type":"check","kind":"tests","runner":"playwright","total":12,"passed":12,"failed":0,"proof":"phases/3/playwright.json"}
{"stage":"coder","phase":3,"type":"artifact","kind":"commit","sha":"a91c2f4","files":7}
{"stage":"coder","phase":3,"type":"end","result":"ok"}
{"stage":"coder","phase":4,"type":"end","result":"blocked","why":"auth stack will not start"}
{"stage":"review","type":"problem","id":"R1","kind":"defect","level":"high","where":"src/auth.ts:42","detail":"== allows type coercion"}
{"stage":"verify","type":"resolution","id":"R1","how":"fixed","commit":"b7d1e08"}
{"stage":"verify","type":"artifact","kind":"proof","path":"verification/proof-report.html"}
{"stage":"ship","type":"artifact","kind":"pr","number":76,"url":"https://github.com/…/pull/76"}
{"type":"end","result":"ok"}
```

## What the gate answers

`$LEDGER state --assert <stage>` exits 1 and prints one of these. Each halts the pipeline.

| Word | Means |
|------|-------|
| `NEVER_RAN` | the stage appended nothing |
| `FAILED` | the stage ended `failed` — the detail is its reason |
| `BLOCKED` | a phase could not run — the detail names the phase and why |
| `NO_TESTS` | a coder phase finished with no `check` of kind `tests` |
| `TESTS_FAILED` | a phase reported a failing test |
| `NO_PROOF` | tests ran but wrote no proof path, or verify wrote no proof report |
| `OPEN_PROBLEMS` | ship was reached while a problem had no resolution — the detail lists the ids |

## What the ledger never holds

The script computes all of these. A stage that wrote them itself could report a false one.

| Fact | Computed from |
|------|---------------|
| cost, tokens, model | the session transcripts, matched by `token` |
| a duration | the `start` and `end` times |
| the user's wait | the `question` and `answer` pairs |
| the review verdict | any `problem` at level `high` means changes are requested |
| open problems | `problem` count minus `resolution` count |
| test totals | the sum of every `check` |
| a stage's result | the worst result among its phases |

Never append an event that states one of these. Read it from `state.json` instead.
