# Comment Triage

The single source for reading a PR's human review comments and judging each one.
`review-fixer` reads this file too.

## Fetch

Run each call once for each `REPOSITORY` and `PR_NUMBER` the caller holds. `rework` passes one
pair per `PRS` entry; `review-fixer` passes the single pair it parsed.

First the PR itself, for a caller that has no checkout yet. `rework` builds that PR's workspace on
`head_branch` and drops the PR when `merged` is set; `review-fixer` already runs in the checkout and
skips this call:

```bash
gh api "repos/${REPOSITORY}/pulls/${PR_NUMBER}" --jq '{head_branch: .head.ref, merged: .merged}'
```

Then its inline comments:

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

**Dispatch one `Explore` subagent per comment**, in that comment's own `repository` worktree, all of
them in one message.

Give each agent its comment's `path`, `line` and `body`, and these three instructions:

1. **Start at `path:line`.** The `diff_hunk` is what the reviewer saw; the file is what is there now.
2. **Widen only when the answer is not at that line**: the enclosing function, its callers, the tests
   covering it, then that range's history when the question is whether someone already fixed it.
3. **Return** the code at that location now, whether the reviewer's claim holds against it, and the
   commit sha when the code changed after the comment was written.

**The verdict follows what the agents return, never the comment body alone.** Give each comment one:

| Verdict | Means |
|---|---|
| `valid` | the reviewer is right, and the fix belongs to this ticket |
| `stale` | already fixed since they commented — cite the commit |
| `out-of-scope` | a real point about code this ticket did not write |
| `wrong` | the code is right as written — name what the reviewer missed |

`wrong` has to be earned: name the behaviour that makes the code correct. Where you cannot, the
verdict is `valid`.

A comment the returned evidence settles neither way leaves triage **unsettled**, and goes back to
the caller to ask about.

## Disposition

Every comment ends on exactly one **disposition**:

- `applied` — verdict `valid`, fix made, report names the change
- `deferred` — verdict `out-of-scope`, report names the follow-up
- `dropped` — verdict `stale` or `wrong`, report carries the reason

**Walk the fetched list by `repository`, `pr_number` and `id`, and account for each one.** A comment
nobody dispositioned is unfinished work, not an accepted risk.
