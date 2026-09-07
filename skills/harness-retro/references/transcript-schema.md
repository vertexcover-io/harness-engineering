# Transcript schema and hand-written queries

`scripts/extract.py` covers the bulk extraction. This file covers what it cannot: the record
shape, and the per-run queries you write yourself during Step 2.

## Layout on disk

```
~/.claude/projects/SLUG/SESSION_ID.jsonl              main transcript
~/.claude/projects/SLUG/SESSION_ID/subagents/         agent-*.jsonl + agent-*.meta.json
```

`SLUG` is the project's working directory with every `/` replaced by `-`. So
`/Users/x/Projects/andromeda` becomes `-Users-x-Projects-andromeda`.

## Record schema

One JSON object per line. Line numbers are 1-based, which makes them citations.

`type` values seen in practice: `user`, `assistant`, `system`, `attachment`, `queue-operation`,
`pr-link`, `file-history-snapshot`, `file-history-delta`, `ai-title`, `last-prompt`, `mode`,
`permission-mode`.

Fields that matter:

- `timestamp` — ISO 8601 UTC. Present on most records, absent on some housekeeping records.
- `uuid`, `parentUuid`, `isSidechain`.
- `message` — `{role, content}`. `content` is a string, or a list of blocks:
  - `{'type':'text','text':...}`
  - `{'type':'tool_use','id','name','input'}`
  - `{'type':'tool_result','tool_use_id','content','is_error'}`
  - `{'type':'thinking',...}` — skip these.
- `toolUseResult` — on user records carrying a tool result. Often holds `stdout`, `stderr`,
  `interrupted`.
- `isMeta` — true on injected non-human user records. Exclude these from the spine.
- `system` records carry `subtype`, plus hook fields `hookCount`, `hookErrors`,
  `preventedContinuation`, `stopReason`, `toolUseID`. Hook blocks live here.
- Incident flags on any record: `error`, `isApiErrorMessage`, `apiErrorStatus`,
  `interruptedMessageId`, `isAbortedMidStream`, `toolDenialKind`.
- `pr-link` records carry `prNumber`, `prUrl`, `prRepository`.

Sub-agent transcripts use the same schema. Each has an `agent-ID.meta.json` beside it. That file
holds one JSON object with no trailing newline: `{agentType, description, toolUseId,
parentAgentId, spawnDepth, model}`. Read it with `json.load`, not line by line.

**Human messages arrive two ways.** A plain `type=='user'` record holds text the human sent while
the agent was idle. Text typed while the agent was working arrives instead as an `attachment`
record (`attachment.type=='queued_command'`, `origin.kind=='human'`) or as a `queue-operation`
record. The two sets overlap but neither contains the other. The queue also carries
`<task-notification>` machine traffic, which needs filtering. `extract.py` handles all of this.

**Sub-agent reports travel back inside `queue-operation` records.** Searching only the assistant
text misses what sub-agents told the orchestrator. Search the raw main transcript.

## Loader

Start any hand-written query with this.

```python
import json

def load(path):
    out = []
    with open(path, errors='replace') as f:
        for i, line in enumerate(f, 1):
            try:
                out.append((i, json.loads(line)))
            except json.JSONDecodeError:
                pass
    return out

def blocks(rec, kind):
    c = (rec.get('message') or {}).get('content')
    if isinstance(c, list):
        return [b for b in c if isinstance(b, dict) and b.get('type') == kind]
    return []
```

## Hand-written queries

These change every run, so they stay recipes rather than script flags.

**Document `Write` payloads** — for the requirement walk. Iterate the records. For each
`tool_use` named `Write`, match `input.file_path` against `PRD`, `design.md`, `plan.md`,
`phase-`, `baseline.json`. Dump `input.content` to one file per document. Then search each dump
for the acceptance bullets' distinctive phrases.

**Full `Agent` dispatch prompts** — for the asserted-facts check. Same iteration,
`name=='Agent'`, dump `input.prompt` whole. The line in `03-tool-calls.txt` is truncated to 600
characters.

**Review files a reviewer wrote** — the worktree may be deleted, but the text survives in the
reviewer's own transcript. Filter that agent's `tool_use` blocks for `name in ('Write','Edit')`
and a path containing `review`. Print `input['content']`.

**Self-indictment scan** — high precision for the exact failure mechanism. After a correction,
agents often state the root cause plainly.

```bash
grep -nE "on me|my fault|I should have|Correction|wrongly|that was wrong" OUT/02-assistant.txt
```

**Injected-evidence scan** — for the verification-honesty walk.

```bash
grep -nE "monkey.?patch|window\._store|page\.route|mock|inject|hardcode|stub" OUT/03-tool-calls.txt
```

**Vacuous-artifact scan** — an artifact that exists but holds a template means its gate passed on
nothing.

```bash
grep -nE "TODO|\{\{|<[a-z-]+>" OUT/03-tool-calls.txt | grep -i write
```

**Phrase hunt across everything** — including sub-agent reports.

```bash
grep -n 'distinctive phrase' MAIN.jsonl | cut -c1-200
python3 scripts/cite.py MAIN.jsonl LINE --context 5
```

## Discipline

- Cap text fields at 400 characters, and at 2000 for human messages. Raise a cap only for the one
  record you are reconstructing.
- Write each hand-written extraction to `OUT/NN-name.txt`. Read the file when the output is long.
- Keep the loader's 1-based numbering. The line number you print is the citation.
