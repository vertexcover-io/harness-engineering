# Stress-Test Lenses

Two uses: Phase 5 walks them against the *chosen approach* before writing the doc; the
completeness gate (`question-completeness.md`) walks them during questioning as *question
sources*. Either way, generative — each finding flows into Requirements, Edge Cases,
Risks, or Decisions.

- **End user:** failure modes visible or silently degrading? For multi-user or
  concurrent systems, also: what does each user perceive of the others and of the
  system's live activity (presence, progress, another actor's changes)?
- **6-months-later maintainer:** where will the next reader get stuck?
- **System under load:** what breaks at 10x / 100x?
- **Adjacent systems:** what contract did we assume that might change?
- **Security & abuse:** who exploits this and how?
- **Failure modes:** what happens when each dependency dies?

Also check: unvalidated assumptions, decision reversibility, edge cases vs. chosen
approach.

If a lens produces nothing, that's suspicious — try again or note why it doesn't apply.
