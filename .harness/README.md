# .harness/ — harness artifact root

| Zone | Git | Lifetime | Safe to... |
|---|---|---|---|
| `knowledge/` | committed | forever — the repo's memory | edit by hand; new learnings go in `docs/learnings/` |
| `features/<spec>/` | committed | frozen once the PR merges | read to review a PR |
| `runtime/<spec>/` | gitignored | dies with the worktree | delete freely (`rm -rf .harness/runtime/`) |

`knowledge/INDEX.md` lists the lessons — one line per lesson, kept in sync by whoever
writes the lesson. On merge conflict: keep both sides' entries and dedupe by hand.
