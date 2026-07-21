---
title: "PI coding agent: skill discovery works via pi.skills manifest + --skill, NOT via a .pi/skills symlink"
date: 2026-07-21
category: tooling
tags: [pi-coding-agent, skills, plugin, discovery, symlink, frontmatter, agent-skills]
component: pi-plugin-support
severity: high
status: implemented
applies_to: ["package.json", "skills/**/SKILL.md", "references/pi-tools.md"]
stage: [plan, code]
evidence_count: 1
last_validated: 2026-07-21
related: ["references/pi-tools.md", "references/codex-tools.md"]
---

# PI coding agent: skill discovery works via pi.skills manifest + --skill, NOT via a .pi/skills symlink

## Problem

Making the harness plugin installable in the PI coding agent (`@earendil-works/pi-coding-agent`,
tested at v0.80.10) required PI to discover the shared `skills/` tree. The obvious approaches — a
`.pi/skills → ../skills` symlink, or a project-root `package.json` `pi.skills` field read in place —
both silently failed: `pi skills` listed only global skills, never the harness ones, with no error.

## Insight

**PI does not traverse a symlinked skills directory for passive discovery, and it does not read a
project-root `package.json` `pi.skills` field until the repo is installed as a PI package.** The two
mechanisms that actually surface skills are:

1. **Installed package** — `pi.skills: ["./skills"]` in the package's `package.json`, activated by
   `pi install git:github.com/owner/repo@ref` or `pi install ./local/path`. After install the skills
   are available **globally**, from any cwd. This is the production path.
2. **`--skill <path>`** — a repeatable CLI flag that loads a skill/dir for one session without
   installing. This is the dev path.

A symlink under `.pi/skills` (whole-tree or per-skill) is skipped by discovery entirely.

Two corollaries that cost real time:

- **The LLM cannot reliably enumerate its own loaded skills.** Asking the agent "which skills do you
  have?" returned `NONE` and named only a competing pre-installed skill, even when `/skill:planning`
  demonstrably loaded. Use the **`pi skills` CLI command** as the discovery oracle, never model
  self-report.
- **PI ignores unknown SKILL.md frontmatter keys silently** (its docs: "Unknown frontmatter fields
  are ignored"). Claude-Code-only keys like `argument-hint` and `user-invocable` are tolerated — do
  not treat them as validation failures. PI's only hard frontmatter rules are `name` (≤64 chars,
  `[a-z0-9-]`) and `description` (≤1024 chars).

## Solution

```json
// file: package.json  (net-new at repo root — none existed)
{
  "name": "harness-engineering",
  "version": "1.15.0",
  "private": true,
  "pi": { "skills": ["./skills"] }
}
```

Verified end-to-end: `pi install ./` then, from a **neutral directory**, `pi --tools read -p
"/skill:tdd"` returned "TDD guidelines loaded" — proving the installed `pi.skills` field surfaces the
shared tree globally. `--skill skills/planning` returned "Planning skill loaded" for the dev path.

The `pi.skills` shape (`["./skills"]`) matches the working `pi-subagents` package exactly.

## Prevention / Reuse

- To make a repo's skills discoverable in PI, point `package.json` `pi.skills` at the tree and install
  via `pi install` — **do not** create a `.pi/skills` symlink and expect passive discovery.
- Verify discovery with `pi skills` (CLI), not by asking the agent what skills it has.
- When auditing SKILL.md frontmatter for PI compatibility, enforce only `name` and `description`;
  unknown keys are ignored, not rejected.
- `/skill:<name>` explicit invocation is the deterministic contract. Implicit description-based
  activation is model-driven and non-deterministic when multiple skills cover the same capability —
  do not gate a test on it.

## Related

- `references/pi-tools.md` — the PI compatibility guide this lesson backs
- `references/codex-tools.md` — the analogous Codex mapping
