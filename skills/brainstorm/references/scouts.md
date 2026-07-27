# Scout Briefs

The dispatch rules (both scouts before the first question, never waited on) live in SKILL.md —
this file is the briefs themselves.

## Codebase scout — always runs

**The scout is told what to look for, never what we intend to build.** It receives the topic
and the four questions below — not the feature request, the PRD, or the approach under
consideration. A scout that knows the destination stops reporting what the code says and
starts reporting what would support the plan; withholding the intent makes that leakage
structurally impossible rather than merely forbidden.

The brief — four standing questions:

1. What exists that already does part of this? (`reuse`)
2. What patterns and conventions must this follow?
3. What are the execution preconditions — how does this actually run, build, and test?
4. What in the touched area is fragile, untested, or legacy?

**Dossier contract** — writes `.harness/<name>/dossier.md`:

- ≤150 lines, verbatim quotes and short snippets only, each with a `file:line` pointer
- Extraction, not interpretation — no summaries of what code "seems to do"
- Returns to the conversation: a 3-5 line gist plus the path

## External scout — thin-patterns trigger only

The codebase says what *we* do; it cannot say what everyone else learned. Dispatch when
**either** holds:

- **Fewer than 3 direct examples** of the pattern this design needs
- **Adjacent-domain-only:** patterns exist for a neighbouring problem but not this one — the
  repo has HTTP clients but no webhook receivers. Aim the query at the domain gap
  specifically, not the general technology.

With 3+ direct, recently-touched examples following current conventions, skip — the repo has
already answered.

It looks for: prior art and how others solved this · known failure modes and postmortems ·
current API/version facts for anything external · cross-domain analogies where the
*constraints* match, not just the vocabulary.

Reading rules: convergence across independent sources is signal; one source repeating itself
is not. Vendor pages overstate and postmortems understate — read them against each other.
Recency matters for pricing and capability claims, less for systems reasoning.

**Returns findings inline as quotes with source URLs — no file.** Every finding either shapes
an approach, a requirement, a risk, or a decision — citing its URL in the section
it shapes — or it is dropped. If research was warranted but could not
run (no network, no tool), record that as an assumption rather than presenting the design as
externally grounded.
