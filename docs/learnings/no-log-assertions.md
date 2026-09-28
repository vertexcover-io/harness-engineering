# Don't test log lines

Tests check what the code does: the value it returns, the files it writes, the events it records, and the errors it raises. They never check what it logged.

- Don't assert on `captureLogger()` output (`logger.at("debug")`, "this line was logged at info").
  - Logs are for people debugging. Their wording and fields change freely, and a test pinned to them breaks for no real reason.
- If something matters enough to test, it should show up in the result.
  - For example, a skipped package is simply absent from `baseline.packages`, and the test checks that.

Source: review of `packages/core/src/stages/baseline.test.ts`, PR #142.
