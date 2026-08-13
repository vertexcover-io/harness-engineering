# Writing style — every human-facing pipeline document

Write every document a person will read in ASD-STE100 Simplified Technical English:
`plan.html` copy and its payloads (`plan.md`, `phases/phase-N.md` — they render in the plan's
drill-downs), README indexes, review reports. The agent-only artifact (`design.md`) is exempt.

Follow these rules:

- Use the active voice.
- Keep sentences to 20 words or fewer.
- Give one idea in each sentence.
- Use simple tenses: present, past, and future.
- Use the same word for the same idea each time.
- Do not use idioms, slang, or jargon.
- Keep paragraphs to 6 sentences or fewer.

Keep technical items exact. Do not change file paths, function names, column names, commands,
or numbers. Write them in full.

The rules control the prose only. They do not control code, command output, logs, or file
contents.

Explain a necessary technical term the first time you use it. Then use that same term for the
rest of the document.

## Sentence checks

Run these on every sentence you write or edit. Concreteness comes first; short follows from it.

- Keep the subject next to its verb. An insertion longer than ~4 words becomes its own sentence.
- Give one topic to each paragraph.
- Name an action, not a quality. "Skip the style rules there" — not "content over style".
- Use one concrete verb in place of stacked abstract nouns. "Check the answers against each
  other" — not "surface consequences the dialogue never probed".
- Announce a list's shape before the list: "one of three things: …".
- Add an example only when the concept is unfamiliar. Then one short example replaces a
  definition. On a plain rule, an example is padding.
