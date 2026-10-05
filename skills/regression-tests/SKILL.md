---
name: regression-tests
description: Discover regression scenarios for an existing user flow, obtain plan approval through Plannotator, delegate test implementation, require test review, then commit and open a PR. Use when a user wants regression tests for a product flow taken through reviewed delivery.
---

# User-flow regression tests

Purpose of this skill is to write regression tests for a product flow that already works, and open a PR with them. All discovery and test-writing instructions are included here.

## 1. Establish scope

Use the user-supplied flow as the scope. Identify its starting and ending points and relevant repositories from that input. Ask for clarification only when missing information materially changes the scenarios.

Read applicable repository guidance. Inspect entry points, implementation, configuration, dependencies, and existing scenarios/tests. Trace the relevant behavior across layers and dependencies.

Use current behavior as the baseline unless the user provides different requirements. Surface conflicts between requirements and implementation. Distinguish source-derived expectations, executed observations, and user requirements when explaining scenario outcomes.

## 2. Generate scenarios and check coverage

Trace the supplied flow through its inputs, available actions, defaults, validation, permissions, calculations, persistence, and immediate or deferred effects. Investigate the conditions and interactions that change outcomes within this flow.

Write one distinct observable behavior per scenario. Include successful journeys, rejection, partial failure, and deferred effects where supported by evidence. Investigate combinations that change observable behavior. Cover several values in one scenario only if the code shows they behave the same way, and say in the plan why they're grouped.

Write for QA and Product readers using complete sentences and familiar product language. Give each scenario enough context to understand the user journey independently. Each field can take one or two complete sentences, or more when needed for clarity.

During planning, tag each scenario `[unit]` or `[service]`. Use `[unit]` when an isolated decision can prove the expected behavior with controlled collaborators. Use `[service]` when the outcome depends on routing, authentication pipelines, persistence, or interactions across real components. When both are needed, tag the scenario `[service]` and let implementation add supporting unit tests.

Give each scenario a numbered heading with a stable unique ID, its tag, and a concise title. Follow it with these bold labels in order, leaving a blank line between fields:

- **What are you testing:** Explain the specific user behavior and condition being checked, adding information beyond the title.
- **Given:** Describe who the user is, their starting situation, and relevant permissions, settings, and data.
- **When:** Describe what the user does in order, including intermediate actions needed to understand the journey.
- **Then:** Explain whether the action succeeds, what the user receives, and which changes remain saved. Include rejection or later effects when relevant.

Use this format, adapting the content to established behavior:

```markdown
### 1. CRS-001 [service]: Create an invoice for the selected business

**What are you testing:** Check that a signed-in user creating an invoice for business A saves it under A, even when they also belong to a newer business B.

**Given:** The user belongs to businesses A and B and has permission and available document allowance to create an invoice for A.

**When:** The user submits a valid invoice for business A.

**Then:** Creation returns an invoice ID, and the saved invoice belongs to A. No invoice is created for B.
```

If the flow can fail, write separate scenarios for failing before anything is saved and failing after it's saved. To prove something was saved, fetch it again instead of trusting the response. When conditions combine, write that combination as one scenario and list every condition in Given.

Check each scenario against the others and against existing tests. If two have the same starting state, action, rule and outcome, merge them. Keep any real difference as its own scenario, and don't change IDs when merging.

Every condition you looked at must end up in one of three places: covered by a scenario, grouped with one that behaves the same, or listed as out of scope. If a condition has no test yet, look into it and base the expected outcome on evidence.

Settle open questions as you go. Check the code and evidence first. Ask the user only when you need them to decide scope, expected behavior, or how to test. Keep investigating other parts while you wait. Write the plan once every question is answered, and put each answer into the scenarios it affects.

## 3. Prepare the plan

Write the plan to `.harness/<slug>/plan.md`. Derive `<slug>` from the supplied flow name using lowercase words separated by hyphens (for example, `create-invoice`). Create the directory as needed.

Use a descriptive document title followed by exactly these sections:

1. **Flow and baseline:** One or two short sentences naming the supplied flow, target repository, and inspected commit.
2. **Scope:** A short paragraph explaining what user behavior is being tested, where the journey starts and ends, and which outcomes matter. Use the same clear QA/Product language as the scenarios. Mention scope boundaries here when needed.
3. **Scenarios:** Numbered scenario headings and the four fields defined above. Group by journey stage within this section when it improves readability.

Leave test files, fixtures, commands, coverage mappings and other implementation details out of the plan. They go in the instructions to the test-writing subagent and in its report. The plan is only for reviewing behavior with the user.

Before opening Plannotator, read every scenario as a QA or Product reviewer would. Each one should make sense on its own, its explanation should say more than its title, and its expected outcome should be specific enough to check. Cut repeated filler and explain any technical shorthand. Check heading levels and blank lines so the Markdown renders cleanly.

## 4. Review through Plannotator

Check Plannotator is installed with `command -v plannotator`. If it's missing, ask the user to install it with this command, and continue once it's installed:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Open the saved plan:

```bash
plannotator annotate .harness/<slug>/plan.md --gate
```

The command blocks until the user decides. Run it in the background and wait for it to exit. A timeout on your side is not a result.

Check the installed Plannotator's docs for what each result means. Move on only when it returns an explicit approval.

- **Send Feedback:** apply the annotations and edits, revise the plan, keep the IDs of scenarios whose behavior didn't change, and open it for review again.
- **Approve:** note exactly which version was approved and move on.
- **Approve with Notes:** pass the notes on to the test-writing subagent. If a note changes scope or expected behavior, revise the plan and get it approved again.
- **Close, cancel, timeout, or unclear result:** the plan is still waiting for review.

Apply any edits Plannotator returns to the saved plan before you record the approval.
## 5. Delegate implementation

Once the plan is approved, create a feature branch or workspace used only by this workflow. Follow the repo's conventions and leave unrelated changes alone.

Start a test-writing subagent. Give it the absolute path to the approved `.harness/<slug>/plan.md` and which version was approved, the evidence you gathered, the repo's guidance, and the test files or modules it owns. Include the instructions below in its task.

### Test-writing instructions

Read the approved plan first. Write tests only for approved scenarios, and put each scenario ID in the test name or in a mapping kept in the repo. Follow the repo's existing test style and reuse its fixtures and helpers. Add to existing tests where they fit, and write new ones only for behavior nothing covers yet.

Use the `[unit]` or `[service]` tag each scenario was approved with. You can add unit tests under a service scenario when they help. If a scenario needs a different kind of test to prove its outcome, tell the parent why so the plan can be revised and approved again.

For each scenario:

1. Understand the starting state, the action, and the expected outcome.
2. Set up the Given state with data each test creates for itself, and control any external services.
3. Run the When action through the kind of test the scenario is tagged with.
4. Check the specific Then outcomes, including what was saved and what happens on failure. Check what a user or caller can see, not which internal functions were called, unless those calls are the point.
5. Write assertions and failure messages that still make sense if the internal code is reorganized.

Tests must not depend on each other or on timing. Wait for background work and clean up the same way the repo's existing tests do. Take expected outcomes from the scenarios and the evidence behind them.

If something unclear would change a test, or the requirements and code disagree, report it to the parent. Keep working on anything that doesn't depend on it. Don't weaken an approved expectation or drop coverage. If a test exposes a bug in the product code, report it so the parent can take it to the user.

Run the tests you added or changed, fix failures, and rerun until they all pass. Then run the related existing test suites and any checks the repo requires. Report success only once these pass, and include the changed files, which test covers which scenario, the exact commands you ran, and their results. If the environment or an open question stops you, report blocked with the failing command and the reason, so the parent can sort it out.

Mark every approved scenario as either newly tested or already covered by an existing test. Report anything left uncovered to the parent before review.

### Parent responsibilities

Check the subagent's work against the approved plan. Sort out blocked results and missing coverage before starting test review. If scope or expected behavior has to change, send the plan back for review. Look over the final diff for unrelated changes or accidental edits to product code, and tell the user about anything significant.

## 6. Review

Start two fresh subagents in one message so they run in parallel. Neither edits files. Both return findings to you, and you make every fix.

### Plan review

The first subagent runs the `harness:regression-review` skill. Give it:

- The absolute path to the approved `plan.md`.
- The final diff and the files it touches.
- Which test covers each scenario.
- The commands to run the new tests.

Handle its results like this:

- **PASS:** move on once the simplify findings are handled.
- **FINDINGS:** verify each finding against the code. Fix `test` findings. For `plan` findings, update `plan.md` and the matching tests yourself, without reopening Plannotator. Take `product` findings to the user. Rerun the tests, then run the plan review again.
- **BLOCKED:** tell the user the reason and what's needed to unblock it.

If the plan review still returns FINDINGS after three rounds, stop and take the remaining findings to the user.

### Simplify

The second subagent runs the native `simplify` skill on the new and changed test files, once. Tell it to report findings without applying them.

Apply a finding only if the test still covers its scenario's Given, When and every Then. Then rerun the tests and the plan review.

### Both reviews

If you check a finding and it's wrong, note it and why in your report, and don't act on it. Any change to the tests after a PASS cancels that PASS, so run the plan review again.

## 7. Commit and open the PR

After the plan review returns PASS and every simplify finding is applied or rejected, use `harness:git-commit` to commit only the reviewed tests, then push the feature branch. Use `harness:git-pr` to open a draft PR, passing the approved plan, scenario IDs, test results and review outcome.

Finish by giving the user the PR link and the commands to run the tests.
