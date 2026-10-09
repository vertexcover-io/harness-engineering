---
signal: Use when catching an error in a background job or webhook handler
paths: ["src/jobs/**/*.ts", "src/webhooks/**/*.ts"]
tags: [errors, sentry]
strength: default
---
# Report caught errors in jobs and webhooks to Sentry

In background jobs and webhook handlers, send caught errors to Sentry with `captureException`, not only `console.log`. Nobody watches the console for these processes, so logged errors are never seen. `catch (error) { Sentry.captureException(error); throw error }`. Rethrow unless the job can safely continue.

**Occurrences:**
- 2026-10-06 · sync job swallowed a fetch failure with console.log
**Stale when:** `@sentry/node` is removed from package.json, or jobs get a shared error-reporting wrapper.
