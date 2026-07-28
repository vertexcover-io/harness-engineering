# Publishing the Evidence

**Read this when:** running the Publish step. SKILL.md holds the contract (three attachments to the
tracker the project names, plus claude-sessions; best-effort, never fails verification). This file
holds two implementations. **Every command here is best-effort — no config, no token, no match, or a
failed upload → say so in one line and move on. The proof report on disk is the source of truth.**

## Tracker publish (Asana implementation)

Three deliverables go up, all as **file attachments**: the proof report (the HTML file itself, not its
text pasted into a comment); a **zip of the whole `verification/` folder** so the report's frames,
videos and files resolve once unzipped; and each **video** individually so they play inline on the task.

The report is a single self-contained HTML file, so it opens from the attachment — but its frames and
files live beside it, so **the zip is the copy a reviewer should actually open**.

**Which tracker, and how a branch maps to a ticket, are project facts.** They live in the project's own
skills (often a git-workflow skill) and `CLAUDE.md`: the tracker (`asana`, `linear`, or `none`), how
the current branch resolves to a ticket, the workspace/project id the call needs, and which env var
holds the token (the token itself lives in `.env.harness`, never in a committed file). **When the
config says `none`, is absent, or its token is unset, skip in one line.** The Asana path below is one
implementation; a project on a different tracker publishes the same three attachments through that
tracker's API, or skips. The example reads the branch→ticket rule from the project's skills — here,
branch `REF-<number>` maps to the task whose name carries that string.

```bash
# Guard: only run when the project's skills name Asana as the tracker AND the token is present.
[ -z "$ASANA_PAT" ] && { echo "tracker not Asana or ASANA_PAT unset — skipping tracker publish"; }

API="https://app.asana.com/api/1.0"
# Workspace GID: exported env first, then a .env at the repo root.
WORKSPACE="${ASANA_WORKSPACE_GID:-$(grep -hs '^ASANA_WORKSPACE_GID=' .env | tail -1 | cut -d= -f2-)}"
[ -z "$WORKSPACE" ] && { echo "ASANA_WORKSPACE_GID not set — export it (or add it to .env), then re-run — skipping Asana publish"; }
BRANCH="$(git branch --show-current)"       # e.g. REF-21666

# 1. Resolve the branch to a task GID (exact REF match, not a fuzzy first hit)
GID=$(curl -s "$API/workspaces/$WORKSPACE/tasks/search?text=$BRANCH&opt_fields=gid,name" \
        -H "Authorization: Bearer $ASANA_PAT" \
      | jq -r --arg b "$BRANCH" '.data[] | select(.name|test($b)) | .gid' | head -1)
[ -z "$GID" ] && GID=$(curl -s "$API/workspaces/$WORKSPACE/tasks/search?text=$BRANCH&opt_fields=gid" \
        -H "Authorization: Bearer $ASANA_PAT" | jq -r '.data[0].gid // empty')
[ -z "$GID" ] && { echo "no Asana task for $BRANCH — skipping Asana publish"; }

# 2. Upload the proof report as a FILE (not a comment/story)
curl -s -X POST "$API/attachments" -H "Authorization: Bearer $ASANA_PAT" \
  -F "parent=$GID" -F "file=@verification/proof-report.html;type=text/html" >/dev/null \
  && echo "attached proof-report.html to task $GID" || echo "FAILED to attach proof-report.html"

# 3. Zip the whole verification folder to a temp path (outside the repo) and attach it
ZIP="$(mktemp -d)/verification.zip"
( cd verification && zip -qr "$ZIP" . ) \
  && curl -s -X POST "$API/attachments" -H "Authorization: Bearer $ASANA_PAT" \
       -F "parent=$GID" -F "file=@$ZIP;type=application/zip" >/dev/null \
     && echo "attached verification.zip" || echo "FAILED to attach verification.zip"
rm -rf "$(dirname "$ZIP")"

# 4. Upload each video individually — NN_<slug>.mp4 at the verification root, no screenshots
for v in verification/*.mp4; do
  [ -f "$v" ] || continue
  curl -s -X POST "$API/attachments" -H "Authorization: Bearer $ASANA_PAT" \
    -F "parent=$GID" -F "file=@$v;type=video/mp4" >/dev/null \
    && echo "attached $v" || echo "FAILED to attach $v"
done
```

Only the report and the `NN_<slug>.mp4` videos publish individually; the loose screenshots ride inside
the zip and stay on disk as machine-readable evidence. If the search returns more than one exact match,
name both in your report-back and let a human pick.

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
