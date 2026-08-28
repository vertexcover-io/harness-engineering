# Writing style

**Write the way an engineer would explain it to the person sitting next to them.**

The test, on any sentence you are unsure about: would you say this out loud to a colleague? If you
would not, or if it cannot be spoken as a sentence at all, rewrite it.
> "suite 22/23 ×2"
> → "The suite passed twice, 22 tests each time."

Your reader has never seen this system. They do not know the repos, the tools, the ticket, or the
words this skill uses internally.

---

## The rules

**Answer first, bookkeeping after.** Open with the verdict, the recommendation, or the thing that
changed — not with scope, method, or a summary of what follows. A reader who stops after the first
paragraph should have the answer. A summary above the findings is a third telling that drifts out
of date.

**Cut anything that would read the same on a different run.** That is the test for padding, and it
works at every size: a sentence restating the one before it, a paragraph of throat-clearing, a
whole section reporting that nothing happened. When the absence is itself a finding, one line
carries it and nothing more.
> "No issues were identified, demonstrating strong practices throughout."
> → "0 findings across 34 files."

**Give the real thing.** The real file, the real number, the real error message. Category words —
*factors*, *aspects*, *considerations*, *issues* — hide the work.
> "The endpoint has performance issues."
> → "p95 latency rose from 120ms to 450ms after the change."

**Use the plain word.** *utilize* → *use*. *leverage* → *use*. *methodology* → *method*.
*functionality* → *feature*. Real technical terms stay.

**Spell out your own jargon.** A word that means something to this skill and nothing to the reader
— *seam*, *handoff*, *altitude*, *precondition* — gets replaced by what it names. The replacement
is longer, and that is correct: a phrase the reader can follow beats a word they must decode.
> "the seam between stages"
> → "the gap between the plan step and the coding step"

**Make the reason carry the weight.** With the why in place, *robust*, *crucial*, *comprehensive*
and *seamless* have nothing left to do.
> "Comprehensive test isolation is crucial here."
> → "This must pass from a fresh database, because a dirty one hides tests leaking into each other."

**Background before defect.** Say what a thing *is* before you say what went wrong with it. One or
two sentences: what the tool does, what these two repos are to each other, why that folder exists.
Then the finding lands on first read.

**Gloss a noun where you use it.** Any name the reader cannot be assumed to know gets its meaning
in the sentence that first needs it — not later, and not as a glossary block up front. A reader who
meets the noun once never has to go looking; a reader who never meets it is not made to learn it.

**One paragraph, one job.** A paragraph answers one question. The tell is adding a sentence to an
existing paragraph instead of asking where that sentence's own home is. Six sentences is the flag
to go looking.

**Prose stays prose.** A three-item thought is a sentence. Bullets are for items a reader will scan
or count. When a section runs long, cut items — do not shorten them into labels.

---

## When the document is a report

Structure — the sections, their order, the fields in a repeated block — belongs to the skill that
generates the document. Follow the format it gives you. Only when a skill names no format do you
choose one. What follows governs the writing inside that structure, whatever it is.

**Match the claim to the evidence, both ways.** For every claim verb, point at the evidence line in
the same document. If you cannot, weaken the verb. If you ran the command, strengthen it.
> "It might be worth considering whether some validation could help."
> → "Add validation at the upload endpoint: it crashes on non-UTF-8 filenames, twice last week."

**Say what you could not determine, and why.** An explicit "nothing in the log records this" beats
a guess, and it tells the next person what to instrument. Label an estimate as an estimate.

**Declare the conditions once, up front.** The machine, the version, the branch. Otherwise a later
claim reads as impossible.

**Quote evidence verbatim.** Trim it, never paraphrase it, and never paraphrase inside a fenced
block. Cap it near 15 lines. Cite it, and give the reader the one command that opens a citation.

**One number, everywhere.** A duration or count that appears twice is identical both times, and a
column that sums must sum. Recompute before you ship.

**An ID never travels alone.** First mention carries the words the reader needs; after that the
bare id may stand in. This holds in commit messages and PR descriptions too.
> "Blocked on TICKET-4471."
> → "Blocked on TICKET-4471 (retries create duplicate records)."

---

## What these rules do not control

**Technical items stay exact.** Paths, commands, versions, numbers. The rules govern prose only —
never code, command output, logs, or file contents.

**Controlled vocabulary stays exact.** Where a skill defines fixed values — a severity of `major`,
a class of `MISSED`, a fix type of `skill-gap` — those are a vocabulary, not prose. Never renamed,
never softened. Gloss each coded column once, in one line, near the table that uses it.

---

## Before you ship

- Recompute every number that appears more than once.
- Is every proper noun glossed above its first use?
- Does every claim verb have an evidence line?
- Delete every section that would read the same on a different run.
