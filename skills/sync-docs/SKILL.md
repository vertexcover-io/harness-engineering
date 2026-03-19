---
name: sync-docs
description: >
  Synchronizes documentation with code changes. Scans for stale, missing, or contradictory
  docs, then updates them to reflect the actual implementation. Structures docs for both
  human readability and AI consumption. Use after code changes are complete and quality
  gate has passed — before committing.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
user-invocable: false
---

# Sync Docs

Ensures documentation stays in sync with code changes. Runs after coding and quality gate,
before commit. Only touches docs relevant to what changed — does not generate unnecessary files.

**Announce at start:** "Syncing documentation with code changes."

---

## Inputs

- **Worktree path** — where the code changes live
- **Spec directory** — `docs/spec/<name>/` for context on what was built
- **Plan directory** — phase files describing what each phase delivered

---

## Process

### Step 1: Identify What Changed

Use `git diff --name-only HEAD` (or against the base branch) to get the list of changed files.

Categorize changes:
- **New public APIs** — exported functions, classes, endpoints, CLI commands
- **Modified public APIs** — signature changes, behavior changes, renamed exports
- **New modules/packages** — entirely new directories or entry points
- **Configuration changes** — new env vars, changed defaults, new dependencies
- **Removed functionality** — deleted exports, deprecated features

### Step 2: Scan Existing Documentation

Use `Glob` and `Grep` to find docs that reference changed code:

1. **README files** — root README, package-level READMEs
2. **CLAUDE.md / AGENTS.md** — project guidance for AI agents
3. **docs/ directory** — architecture docs, guides, API references
4. **Inline documentation** — JSDoc, docstrings, type annotations on changed files
5. **Config references** — .env.example, docker-compose comments, CI config docs

### Step 3: Diff Docs Against Code

For each doc found, check:
- Does it reference APIs/functions that changed signature or behavior?
- Does it describe patterns that the new code contradicts?
- Does it list files/paths that were moved or renamed?
- Does it omit new public APIs that users or AI agents would need to know about?
- Does it reference removed functionality?

### Step 4: Update Documentation

Apply updates using `Edit` (prefer over `Write` for existing files):

**What to update:**
- README sections that describe affected features
- CLAUDE.md if project conventions, tooling commands, or architecture changed
- Inline docs (JSDoc/docstrings) on changed public API surfaces
- Architecture docs that reference modified components
- Config examples if new env vars or settings were added

**What NOT to do:**
- Don't create new doc files unless genuinely needed (e.g., a whole new subsystem)
- Don't add boilerplate or filler content
- Don't document internal/private implementation details
- Don't add redundant comments that just restate the code
- Don't touch docs unrelated to the changes

### Step 5: Structure for Dual Audience

Ensure updated docs work for both humans and AI:

**For humans:**
- Clear headings that scan well
- Concise prose — no fluff, no promotional language
- Examples where the usage isn't obvious
- Logical reading order

**For AI:**
- Consistent heading hierarchy (AI uses these to navigate)
- File paths as `path/to/file.ext` (not vague references)
- Explicit descriptions over implied context
- Structured formats where applicable (tables, lists with clear labels)

---

## Output

Return a summary of what was updated:

```
Docs synced:
- Updated: README.md — added new CLI command section
- Updated: CLAUDE.md — added new env var, updated build command
- Updated: src/auth/handler.ts — JSDoc on exported authenticate()
- No changes needed: docs/architecture.md
```

If no documentation updates were needed, report that explicitly.
