# Health Heuristics — Registry Commands

Cheap, deterministic queries to score a library as `trusted` / `suspicious` / `dead`.
All commands are read-only and rate-friendly. No auth required for any of these.

---

## npm

```bash
# Last publish + deprecated flag + weekly downloads
npm view <pkg> --json time.modified deprecated 2>/dev/null
curl -s "https://api.npmjs.org/downloads/point/last-week/<pkg>" | jq '.downloads'
```

## PyPI

```bash
curl -s "https://pypi.org/pypi/<pkg>/json" \
  | jq '{updated: .urls[0].upload_time, yanked: .info.yanked, summary: .info.summary}'
# Downloads (BigQuery proxy via pypistats)
curl -s "https://pypistats.org/api/packages/<pkg>/recent" | jq '.data.last_week'
```

## Go modules

```bash
curl -s "https://proxy.golang.org/<module>/@latest" | jq
# Activity → fall back to GitHub API on the source repo
```

## Cargo

```bash
curl -s "https://crates.io/api/v1/crates/<pkg>" \
  | jq '{updated: .crate.updated_at, downloads: .crate.recent_downloads, yanked: .versions[0].yanked}'
```

## GitHub (works for any repo, regardless of registry)

```bash
# Last commit on default branch
gh api "repos/<owner>/<repo>" --jq '{pushed_at, archived, fork, parent: .parent.full_name}'

# Open issue ratio
gh api "repos/<owner>/<repo>" --jq '.open_issues_count'
gh api "search/issues?q=repo:<owner>/<repo>+is:issue" --jq '.total_count'

# Fork-vs-source: if `fork=true`, check parent activity
gh api "repos/<parent>" --jq '.pushed_at'
```

---

## Scoring

```
trusted:    last_commit < 6mo  AND  not deprecated  AND  not archived
suspicious: 6mo ≤ last_commit < 12mo  OR  open_issue_ratio > 0.4 (with >50 open)
            OR  weekly_downloads < 1000
dead:       last_commit > 12mo  OR  archived  OR  deprecated  OR  yanked
            OR  is fork-of-active-parent that is behind parent by > 100 commits
```

When in doubt, mark `suspicious` — the smoke test is the source of truth.

---

## Output schema (`probes/<lib>/health.json`)

```json
{
  "library": "tweepy",
  "registry": "pypi",
  "last_commit": "2024-08-12T...",
  "deprecated": false,
  "archived": false,
  "weekly_downloads": 482103,
  "open_issues": 47,
  "open_issue_ratio": 0.12,
  "is_fork": false,
  "score": "trusted",
  "thresholds_tripped": []
}
```
