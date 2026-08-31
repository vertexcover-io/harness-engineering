# Comment Triage

The single source for reading a PR's human review comments and judging each one.
`review-fixer` reads this file too.

## Fetch

Run both calls once for each `REPOSITORY` and `PR_NUMBER` the caller holds. `rework` passes one
pair per `PRS` entry; `review-fixer` passes the single pair it parsed.

```bash
gh api "repos/${REPOSITORY}/pulls/${PR_NUMBER}/comments" \
  --jq "[.[] | {repository: \"${REPOSITORY}\", pr_number: ${PR_NUMBER}, id: .id, path: .path, line: (.line // .original_line), body: .body, diff_hunk: .diff_hunk}]"
```

Per entry: `repository`, `pr_number`, `id`, `path`, `line`, `body` (what the reviewer wrote),
`diff_hunk` (the code they wrote it against). Identify a comment by `repository`, `pr_number` and
`id` together. `id` alone repeats across repos.

Then the review summaries, which often carry a request no inline comment does:

```bash
gh api "repos/${REPOSITORY}/pulls/${PR_NUMBER}/reviews" --jq '[.[] | {body, state}]'
```

Concatenate every PR's results into one list before triage.

Nothing from any call is a halt — there is no feedback to rework.

## Triage

**Dispatch one general-purpose subagent to read the code at every comment's `path:line`** and report
back what is there now, per comment. The diff hunk is what the reviewer saw, which may no longer be
what is there. You judge from what the subagent returns.

Give each comment one **verdict**:

| Verdict | Means |
|---|---|
| `valid` | the reviewer is right, and the fix belongs to this ticket |
| `stale` | already fixed since they commented — cite the commit |
| `out-of-scope` | a real point about code this ticket did not write |
| `wrong` | the code is right as written — name what the reviewer missed |

`wrong` has to be earned: name the behaviour that makes the code correct. Where you cannot, the
verdict is `valid`.

## Disposition

Every comment ends on exactly one **disposition**:

- `applied` — verdict `valid`, fix made, report names the change
- `deferred` — verdict `out-of-scope`, report names the follow-up
- `dropped` — verdict `stale` or `wrong`, report carries the reason

**Walk the fetched list by `repository`, `pr_number` and `id`, and account for each one.** A comment
nobody dispositioned is unfinished work, not an accepted risk.
