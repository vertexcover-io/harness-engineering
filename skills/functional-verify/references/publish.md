# Publishing the Evidence

**Read this when:** running the Publish step. SKILL.md holds the contract (one attachment to the
tracker the project names, plus claude-sessions; best-effort, never fails verification). This file
holds two implementations. **Every command here is best-effort — no config, no token, no match, or a
failed upload → say so in one line and move on. The proof report on disk is the source of truth.**

## Tracker publish

**A zip of the whole `verification/` folder is the delivery** — one file attachment, and the report,
frames and videos ride inside it. The report is self-contained HTML, but its frames and files live
beside it, so the zip is the copy that opens correctly.

The ticket belongs to the humans reading it: a PR link, a design, a plan, and this one zip. Keep it
that way — a loose report, a wall of `.mp4` attachments, or a summary comment buries what they came
for.

**Which tracker, and how a branch maps to a ticket, are project facts.** They live in the `tracker`
block of the project's `orchestrate.config.json` (documented in
`skills/orchestrate/references/config.md`): the provider, and the regex that resolves the current
branch to a ticket ref. Credentials live in the environment or `.env` at the main repo root, never
in a committed file. The bridge below reads all of that itself — **a missing block, credential,
ticket, or capability prints one line and exits 0**, which is exactly the skip this step wants.

```bash
# Zip the whole verification folder to a temp path (outside the repo) and attach it — the only upload
ZIP="$(mktemp -d)/verification.zip"
( cd verification && zip -qr "$ZIP" . ) \
  && node --experimental-strip-types "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/skills/_shared/tracker.ts" \
       attach --file "$ZIP" --name verification.zip
rm -rf "$(dirname "$ZIP")"
```

The provider decides what "attach" means for its tracker (Asana: a task attachment). A provider
without the capability, or a branch that resolves to no ticket, reports itself in the one line —
repeat that line in your report-back so a human knows where the evidence did not land.

## Claude Sessions publish

Give the same evidence a second home: the Claude Code session you are running in. Pushing the proof
report and the videos here makes them show up in the Sessions web UI's Artifacts tab.

The session id reaches you one of two ways. **When orchestrate runs this skill as a sub-agent it
exports `SESSION_ID`** — the real top-level session — and you use it verbatim. On a **standalone run
nothing injects it**, so you derive it: a session's transcript is a `<session-id>.jsonl` file under
`~/.claude/projects/<encoded-cwd>/`, where `<encoded-cwd>` is the cwd with every `/` replaced by `-`,
and the session you are in is the newest transcript there. Deriving from inside an orchestrate worktree
would resolve the *wrong* id — which is exactly why orchestrate injects `SESSION_ID`.

```bash
# Only proceed when the CLI is installed AND authenticated.
if command -v claude-sessions >/dev/null 2>&1 && claude-sessions status >/dev/null 2>&1; then
  # Prefer the injected id (orchestrate); else derive from the newest transcript under the cwd.
  ENC=$(pwd | sed 's#/#-#g')
  SID="${SESSION_ID:-$(basename "$(ls -t ~/.claude/projects/$ENC/*.jsonl 2>/dev/null | head -1)" .jsonl 2>/dev/null)}"

  if [ -n "$SID" ]; then
    # --file/--glob replace auto-derivation, so only the report and the videos go up.
    claude-sessions artifacts "$SID" \
      --file verification/proof-report.html \
      --glob 'verification/*.mp4' \
      && echo "published proof report + videos to claude-sessions ($SID)" \
      || echo "claude-sessions push failed — skipping (proof report on disk is the source of truth)"
  else
    echo "no local session transcript found — skipping claude-sessions publish"
  fi
else
  echo "claude-sessions not installed or not authenticated — skipping claude-sessions publish"
fi
```
