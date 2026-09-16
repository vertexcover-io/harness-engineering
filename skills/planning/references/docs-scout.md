# Docs scout — the brief

Dispatched from step 1, alongside the code sweep.

This scout's job is to find what the project has already written down that binds this task: the
ADRs and the docs under `docs/`. It reads and reports; it does not write.

Give it the task — the ticket, PRD path, or prompt — and the project's repo root.

## ADRs

Filter from cheapest to most expensive read; stop opening a file the moment it proves irrelevant.

1. **Read `docs/adr/INDEX.md`.** Each line is `[NNNN title](file) · status · date · tags · what it
   requires`.
2. **Name the parts of the system the task touches** — its components and the connectors between
   them — in the index's own tag vocabulary.
3. **Pick from the index.** Drop every `inactive` line. Keep a line when its tags match a part the
   task touches, or its title or summary does.
4. **Read the front matter** of each kept ADR. Drop it when its `status` or `tags` show it does not
   apply after all.
5. **Read the full file** of what remains.

## Other docs

Everything under `docs/` except `docs/adr/`. List the files; judge each by its path and headings
first. Open only those that describe a part of the system the task touches, and read the sections
that bind it — a contract, a constraint, a convention the code must follow.

## Returns

One line per doc that binds the task, nothing for the rest:

```
docs/adr/0003-postgres-only-datastore.md — embeddings must stay in Postgres
docs/architecture/search.md#ranking — results are ranked server-side, never in the client
```

**Best-effort.** No `docs/`, no `docs/adr/INDEX.md`, or nothing relevant — return one line saying
which. An absent record is a fact the plan can act on; a stalled scout is not.
