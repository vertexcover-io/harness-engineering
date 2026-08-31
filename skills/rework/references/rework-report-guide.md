# Writing the Rework Report

**Read this when:** the pipeline has returned and you are writing
`<REWORK_SPEC_DIR>/rework-report.html`, the run's one artifact.

Copy `references/rework-report-template.html` there and **fill its JSON island, the
`<script type="application/json" id="report-data">` block. Change nothing else in the file.** The
comment above that block names every key. This file is how to write what goes in them.

A developer reads this once, quickly, and acts. These nine rules are what make that possible.

## 1. It reads top to bottom

The template fixes the order: the header, the summary, one card per comment, then the caveats. Fill
it in that order and the page needs no navigation.

## 2. The header answers the five questions first

`header[]` holds five rows, in this order: Task, PR, Reason for rework, Verification, Fix.

`Fix` is a count of comments fixed over comments received, not prose. `PR` names every repo when
the rework spans more than one.

## 3. The summary is the whole run in 3-4 lines

Say what the reviewer asked for and what changed, naming the files and the counts. Then what is
still open and who decides it. Then the commit sha, and whether it is pushed.

It repeats no card.

## 4. Everything about an item is in that item's card

Their words, the code, the verdict, the fix, the reasoning. A reader who reaches the end of a card
knows everything the report has on that item and never has to look for the rest of it.

## 5. `why` answers its own heading

The page picks the heading from `verdict`:

| `verdict` | Heading |
|---|---|
| `valid` | Why this is an issue |
| `wrong` | Why this is not an issue |
| `stale` | Why this no longer applies |
| `out-of-scope` | Why this is not for this ticket |

Write the answer to that question. On a `valid` item, say what breaks and what the fix does about
it, and name the other sites carrying the same defect. On `wrong`, name what the reviewer missed.

When a verdict changes late in triage, rewrite the `why` to match its new heading.

## 6. A `file:line` arrives with its code

Fill `context.code` with the lines that are at that location now, `context.from` with the first
line's number, and `context.mark` with the line under discussion. The developer reads the code in
the report instead of opening the file.

The same holds for a change: `changes[].file` is `path:line-range`, and `changes[].diff` is the
actual diff.

## 7. Link every external URL, and only those

The page renders an anchor when a value starts `http://` or `https://`, and plain text otherwise.

Link every commit, PR and ticket. Build the URLs from `REPOSITORY`, which
`references/comment-triage.md` resolves. A commit is
`https://github.com/<REPOSITORY>/commit/<sha>`.

Write a path to a local file as `` `code` ``, never as a link.

## 8. Every line is load bearing

If removing a sentence costs the developer nothing, remove it. A `why` that restates the verdict, or
a `caveats[].detail` that repeats its own `title`, is the reader's time for no information.

- **Cut a bold label that restates its own line.**
- **Use the number of items there are.** Do not pad a list to reach three.

Write a caveat only when a reader has to act on it or know it before trusting the run: a partial
proof, a red baseline, work left open. A check that passed is not a caveat. When every check
passed and the proof is complete, omit the `caveats` key.

## 9. Plain sentences, in a developer's words

A sentence states a fact about this code, this comment or this run.

- **No metaphors.** Say what happened, not what it was like. This covers abstract nouns that read
  as technical and name nothing concrete. Use the concrete word. Keep `blast radius`, which is this
  pipeline's term for the traced id set.
- **No em dashes.** A comma, a colon or a full stop carries every join you need.
- **No inflated words.** Nothing chosen to sound weightier than the fact it reports.
- **No filler.** Cut a transition or a hedge that carries no fact.
- **Use active voice. Name who acts.** Find `is`, `are`, `was` or `were` followed by a past
  participle, then rewrite with the actor as the subject. Passive is right only when the actor is
  unknown.
- **Cut adverbs, or use a stronger verb.** An adverb of degree becomes the measured number.
- **Delete a sentence that would fit another project's report.** If it names no file, number,
  function or decision from this run, it tells the reader nothing.

Name things exactly: the function, the file, the value, the status code. A reader should be able to
check any sentence against the repo.

## What the developer has to do

A `deferred` item is work that is still open. Its `followUp` says what has to happen and who
decides. That is the only thing this report asks of a reader, so it has to be exact.
