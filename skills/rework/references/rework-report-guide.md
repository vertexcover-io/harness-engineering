# Writing the Rework Report

**Read this when:** the pipeline has returned and you are writing
`<REWORK_SPEC_DIR>/rework-report.html`, the run's one artifact.

Copy `references/rework-report-template.html` there and **fill its JSON island, the
`<script type="application/json" id="report-data">` block. Change nothing else in the file.** The
comment above that block names every key. This file is how to write what goes in them.

A developer reads this once, quickly, and acts. These five rules are what make that possible.

## 1. It reads top to bottom

The template fixes the order: what the run was, what came back, each item, what was re-verified,
what the checks said. Fill it in that order and the page needs no navigation.

## 2. Everything about an item is in that item's card

Their words, the code, the verdict, the fix, the reasoning. A reader who reaches the end of a card
knows everything the report has on that item and never has to look for the rest of it.

`summary` is the whole run in one sentence, so it repeats no card.

## 3. A `file:line` arrives with its code

Fill `context.code` with the lines that are at that location now, `context.from` with the first
line's number, and `context.mark` with the line under discussion. The developer reads the code in
the report instead of opening the file.

The same holds for a change: `changes[].file` is `path:line-range`, and `changes[].diff` is the
actual diff.

## 4. Every line is load bearing

If removing a sentence costs the developer nothing, remove it. A `why` that restates the verdict, a
`detail` that repeats the check's name, a `notReverified[].why` that repeats the behaviour: all of
these are the reader's time for no information.

## 5. Plain sentences, in a developer's words

Write the way you would explain it at their desk. A sentence states a fact about this code, this
comment or this run.

- **No metaphors.** Say what happened, not what it was like.
- **No em dashes.** A comma, a colon or a full stop carries every join you need.
- **No inflated words.** Nothing chosen to sound weightier than the fact it reports.
- **No filler.** "Additionally", "leverage", "seamlessly", "it is worth noting" all go.

Name things exactly: the function, the file, the value, the status code. A reader should be able to
check any sentence against the repo.

## What the developer has to do

A `deferred` item is work that is still open. Its `followUp` says what has to happen and who
decides. That is the only thing this report asks of a reader, so it has to be exact.
