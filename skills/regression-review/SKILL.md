---
name: regression-test-review
description: Review regression tests written from an approved plan.md and return findings without editing any file. Checks every scenario is covered, each test matches its scenario, the new tests pass and can fail, and they follow the repo's existing test patterns. Use from user-flow-regression-tests after tests are written, or when asked to review regression tests against a plan.
---

# Regression test review

Purpose of this skill is to check that the new regression tests match the approved plan, pass, and look like the repo's existing tests, and to report every problem found. It runs in a subagent and never edits files. The main agent verifies each finding and makes the fixes.

You need the approved `plan.md`, the diff of the new tests, the scenario-to-test mapping, and the test commands.

## 1. Every scenario is covered

List every scenario ID in the plan. For each one, find the test that covers it. Mark it **covered**, **already covered by an existing test** (name the test), or **missing**. Also list any new test that doesn't belong to a scenario.

## 2. Each test matches its scenario

For each scenario, read its Given, When and Then next to the test:

- **Given:** the test sets up the same user, permissions, settings and data.
- **When:** the test does the same action, through the kind of test the scenario is tagged with (`[unit]` or `[service]`).
- **Then:** the test checks every outcome listed, including what was saved and what must not happen. A missing check counts as a mismatch.

When they don't match, read the product code to decide which side is wrong, and label the finding:

- **test:** the test doesn't do what the scenario says.
- **plan:** the code behaves differently from the plan, and that looks intended. The plan needs updating.
- **product:** the plan describes the right behavior and the code looks wrong. Possible product bug.

## 3. New tests pass, and can fail

Run every new or changed test once. Report any failure with its output.

For each scenario's test, name the product code its main assertion depends on. Report any test that would still pass if that code were broken, for example:

- It checks a value the test set up itself, not one the product code produced.
- It only checks that a mock was called, not what the user or caller gets back.
- Its assertion can never fail, like checking that a result exists when the code always returns something.

## 4. Tests follow the repo's patterns

Find two or three existing tests for the same area and compare:

- Where test files live and how they're named.
- Test runner, setup and teardown.
- How data is created: existing fixtures, factories and helpers, not new copies of them.
- What gets mocked and how.
- Assertion style and how async work is awaited.

Report each difference that has no clear reason, naming the existing test it should follow.

## 5. Report

Return one result:

- **PASS:** no findings.
- **FINDINGS:** one or more problems to fix.
- **BLOCKED:** the review can't finish, for example when tests can't run here. Give the reason and the failing command.

List each finding with:

- Scenario ID and check number (1–4).
- File and line.
- What's wrong, with the evidence: the plan text, the test code, or the command output.
- Suggested fix.
- Label: `test`, `plan` or `product`.

End with a table of every scenario: its ID, its test name, and pass or fail for each check.
