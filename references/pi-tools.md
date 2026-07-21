# PI compatibility guide

Harness was authored against the Claude Code vocabulary. The **PI coding agent**
(`@earendil-works/pi-coding-agent`) is the third supported target, alongside Claude Code and Codex.
This document maps harness onto PI's surfaces.

## Skills (drop-in)

PI implements the same **Agent Skills open standard** harness already uses: a `SKILL.md` with
`name` + `description` frontmatter. **No per-skill change is needed** — PI reads the same `skills/`
tree Claude Code and Codex read.

PI's frontmatter rules (verified against the earendil-works/pi skills docs):

- `name` — ≤64 chars, `[a-z0-9-]` only.
- `description` — ≤1024 chars. Folded (`>`) multi-line descriptions are supported.
- **Unknown keys are ignored silently.** Claude-Code-only keys such as `argument-hint` and
  `user-invocable` are tolerated and do not block loading.

`hooks/pi-skill-audit.mjs` enforces these rules over every `skills/*/SKILL.md`; run it with
`node hooks/pi-skill-audit.mjs` (exits non-zero and lists any violation). All harness skills pass.

### Discovery (verified against pi 0.80.10)

Two mechanisms work for harness; a third does not:

1. **Installed package** (production) — the root `package.json` `pi.skills: ["./skills"]` field.
   After `pi install git:github.com/vertexcover-io/harness-engineering@main` (or `pi install ./path`
   from a checkout), the skills are available **globally**, from any directory. This is the shape the
   working `pi-subagents` package uses, and the path the README documents.
2. **`--skill <path>`** (development) — repeatable flag that loads a skill or a dir of skills without
   installing: `pi --skill skills/planning`.

**Not supported:** a `.pi/skills` symlink pointing at the shared `skills/` tree is **not** traversed
by PI's passive discovery — a symlinked skills directory is skipped. Use the install path or
`--skill`, not a symlink.

`pi skills` (the CLI list command) is the discovery oracle — the model cannot reliably enumerate its
own loaded skills, so verify discovery with `pi skills`, not by asking the agent.

### Invocation

- Explicit: `/skill:<name>` (e.g. `/skill:planning create a plan for X`).
- Implicit: PI auto-activates a skill from its `description` frontmatter when a prompt matches.

## Tool vocabulary

PI's built-in tools (read, bash, edit, write) match the Claude Code / Codex semantics harness skills
assume. The tool-name differences documented in [`codex-tools.md`](./codex-tools.md) apply to PI as
well where a skill references a Claude-Code tool name.

<!-- Hooks and install/manifest sections are added by Phases 2 and 3. -->
