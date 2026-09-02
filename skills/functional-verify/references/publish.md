# Publishing the Evidence

**Read this when:** running the Publish step. SKILL.md holds the contract (one attachment to the
tracker the project names; best-effort, never fails verification). This file holds the
implementation. **Every command here is best-effort — no config, no token, no match, or a
failed upload → say so in one line and move on. The proof report on disk is the source of truth.**

## Tracker publish (Asana implementation)

**A zip of the whole `verification/` folder is the delivery** — one file attachment, and the report,
frames and videos ride inside it. The report is self-contained HTML, but its frames and files live
beside it, so the zip is the copy that opens correctly.

The ticket belongs to the humans reading it: a PR link, a design, a plan, and this one zip. Keep it
that way — a loose report, a wall of `.mp4` attachments, or a summary comment buries what they came
for.

**Which tracker, and how a branch maps to a ticket, are project facts.** They live in the project's own
skills (often a git-workflow skill) and `CLAUDE.md`: the tracker (`asana`, `linear`, or `none`), how
the current branch resolves to a ticket, the workspace/project id the call needs, and which env var
holds the token (the token itself lives in `.env.harness`, never in a committed file). **When the
config says `none`, is absent, or its token is unset, skip in one line.** The Asana path below is one
implementation; a project on a different tracker publishes the same single attachment through that
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

# 2. Zip the whole verification folder to a temp path (outside the repo) and attach it — the only upload
ZIP="$(mktemp -d)/verification.zip"
( cd verification && zip -qr "$ZIP" . ) \
  && curl -s -X POST "$API/attachments" -H "Authorization: Bearer $ASANA_PAT" \
       -F "parent=$GID" -F "file=@$ZIP;type=application/zip" >/dev/null \
     && echo "attached verification.zip to task $GID" || echo "FAILED to attach verification.zip"
rm -rf "$(dirname "$ZIP")"
```

If the search returns more than one exact match, name both in your report-back and let a human pick.
