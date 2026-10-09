# Learning format

One file per learning: `docs/learnings/<kebab-title>.md`. The frontmatter, `Occurrences` and
`Stale when` are fixed. The body in between is free-form: write whatever the next agent needs to
follow the learning (what to do, why, a short snippet if it helps), in at most a few sentences.

```markdown
---
signal: Use when <the moment this applies, written as a trigger>
paths: ["<glob of the files it applies to>"]
tags: [<tag>, <tag>]
strength: hard-rule | default | gotcha
---
# <The learning in one sentence>

<Free-form body, a few sentences at most.>

**Occurrences:**
- <YYYY-MM-DD> · <what happened, one line>

**Stale when:** <what change would make this learning wrong>
```

## Fields

- `signal`: starts with "Use when". It is what an agent matches against, so name the moment
  ("Use when catching errors in a background job"), not the topic ("Error handling").
- `paths`: as narrow as the learning really is. Inline list syntax (`["src/jobs/**/*.ts"]`).
- `strength`:
  - `hard-rule`: breaking it is a bug, or a documented team rule says so.
  - `default`: the usual choice; deviate only with a reason.
  - `gotcha`: a trap that isn't obvious from the code.
- `Stale when`: required. Name a concrete, checkable condition: a file, path, dependency or API
  whose change or removal makes the learning wrong ("`src/lib/sentry.ts` is removed", "we drop
  `@sentry/node`"). A weekly cleanup will check these, so avoid vague ones like "if things change".

## index.md

`docs/learnings/index.md` has one line per learning, newest last: a markdown link whose text is
the title and whose target is the learning's file name, then ` — ` and its signal.

```markdown
- [<title>](<file name>) — <signal>
```

Create it with a `# Learnings` heading if it doesn't exist.

## Example

```markdown
---
signal: Use when catching an error in a background job or webhook handler
paths: ["src/jobs/**/*.ts", "src/webhooks/**/*.ts"]
tags: [errors, sentry]
strength: default
---
# Report caught errors in jobs and webhooks to Sentry

In background jobs and webhook handlers, send caught errors to Sentry with `captureException`,
not only `console.log`: nobody watches the console for these processes. Rethrow unless the job can
safely continue: `catch (error) { Sentry.captureException(error); throw error }`.

**Occurrences:**
- 2026-10-06 · sync job swallowed a fetch failure with console.log

**Stale when:** `@sentry/node` is removed from package.json, or jobs get a shared error-reporting wrapper.
```
