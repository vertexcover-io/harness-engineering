# ViBench — Research Report

*How the "Vibe Coding" benchmark works and how its score is calculated.*

Sources: [vibench.ai](https://vibench.ai/) · [vibench.ai/method](https://vibench.ai/method) · [github.com/ViBench/vibench-public](https://github.com/ViBench/vibench-public) · paper [arXiv:2603.04601](https://arxiv.org/abs/2603.04601) / [ACM CAIS '26](https://www.caisconf.org/program/2026/papers/vibench-a-benchmark-on-vibe-coding/)

---

## 1. What ViBench is

ViBench ("A Benchmark on Vibe Coding") is an **open-source benchmark from Replit** for evaluating AI coding agents on *vibe coding* — the workflow where a user describes an app in natural language and an autonomous agent does all the implementation. It is published at ACM CAIS '26 (Zhong et al., 2026; DOI `10.1145/3786335.3813162`) with a companion site at vibench.ai and a public harness on GitHub.

Rather than scoring code style or unit tests, ViBench judges whether the **finished app actually works for an end user**. Each task gives a model a product requirements document (PRD); the model must build a real, deployable web app from scratch in a sandbox; an autonomous browser agent then drives the running app and scores it on observable behavior.

The benchmark is built around three design goals:
- **Realism** — tasks resemble what non-technical users actually ask for.
- **Reproducibility** — standardized sandbox, seeded data, run manifests, everything in Docker.
- **Implementation-agnostic evaluation** — apps are judged by *user-visible behavior*, not by how they're built.

> ⚠️ **Naming caveat:** the preprint arXiv:2603.04601 is titled *"Vibe Code Bench"* but its methodology (React/Vite + Supabase, browser-agent grading, 90% substep rule, 50+50 split) matches ViBench exactly — they are the same work, likely retitled between preprint and the CAIS camera-ready. Several *other*, unrelated projects also use the name "vibe code bench"; those are not this benchmark.

---

## 2. Dataset & task design

| Item | Value |
|---|---|
| Total application specs | **100** |
| Public validation split | **50 tasks** |
| Held-out test split | **50 tasks** |
| Total workflows (across both splits) | ~964 |
| Total substeps | ~10,131 |
| Tech target | React/Vite frontend + **Supabase** backend, browser-based apps only |

Each task asks the model to build an app **from scratch** in a sandboxed container with access to a browser, a terminal, and common production services (auth, databases, payments, email).

In the public harness, specs live under `prds/`. Each app has:
- `prd/*.txt` — `mvp`, `feature1`, `feature2`, … (the MVP plus incremental feature add-ons)
- `tests/{artifact}/` — matching **test plans** for each artifact

A test plan (the unit that gets scored) is a structured document of sequential **steps**; each step is one or more **actions** + **verifications**, carries a point value, and is flagged fatal/non-fatal. Example (the wishlist demo): 4 steps worth `1 + 1 + 2 + 3 = 7` total points.

---

## 3. The pipeline (how a result is produced)

Every build, seed, server, and evaluation runs in its own isolated Docker stack. There are three pipeline shapes:

1. **Standard pipeline** (`prds/` → `results/`): build MVP and feature artifacts → seed each test plan's preconditions → evaluate only the test plans that seeded successfully.
2. **Parallel-merge pipeline** (`prds-multiagent/`): build one MVP, build each feature independently from that MVP, merge the feature bundles, then evaluate the merged app.
3. **Sequential multi-agent baseline**: one long-lived agent conversation handles MVP + features in order (`order.json`).

For each `app / model / feature / test_plan`, the stages are:
**build** → **seed** (load required DB state/assets) → **serve** → **evaluate** (browser agent) → write `agent_evaluation/evaluation-finished.json`.

Build failures and seeding failures are recorded as **explicit zero-score** results, not dropped.

---

## 4. How a single test plan is scored (the core judgment)

A test plan is graded by an **autonomous browser agent** — an LLM acting as a QA engineer (the paper uses *Browser Use* driven by Claude Sonnet 4.5; fresh headless browser at 1920×1200, capped at ~100 agent steps). The grading rules (from `evaluation_prompt.j2`):

- Execute steps **strictly sequentially**, in order — no reloading or extra actions that could mask bugs.
- Each step is scored **all-or-nothing**: full points if it passes, **0 if it fails — no partial credit**.
- **Fatal sub-step failure** (the default): the step gets 0 *and the entire test plan stops* — all remaining steps score 0.
- **Non-fatal** sub-step failure: that step gets 0, but evaluation continues to the next step.
- If the server doesn't even start, every step fails automatically.
- The agent judges like a human QA: tolerant of cosmetic/phrasing differences, strict on actual functional/behavioral deviations. It is told **not** to debug, fix, or modify the app — only to observe whether each step works.

When done, the agent calls the `finish_evaluation` tool, emitting:
```
{ "score": <points awarded>, "full_points": <max points>, "steps": [ {description, points}, ... ] }
```
This `evaluation-finished.json` is the atomic scoring record everything else is built from.

---

## 5. How the overall score is calculated — two distinct metrics

The same per-step point judgments feed **two different aggregation schemes**. This is the most important and most easily confused part of ViBench.

### A) Paper / leaderboard headline metric — "workflow pass accuracy"

This is the number quoted in the paper and on the site.

1. **Substep** = one action/verification the evaluator performs.
2. A **workflow (test plan) passes** if **≥ 90% of its substeps succeed.** (The 90% threshold tolerates minor non-critical errors while requiring near-complete correctness.)
3. **Application accuracy** = the **percentage of that app's workflows that pass.**
4. **Model score** = the **mean of the per-app accuracies** across the 50 test apps, reported with standard error:

   $$\bar a_m \pm \text{SE}_m, \qquad \text{SE}_m = \frac{s_m}{\sqrt{n}}, \quad n = 50$$

So the headline metric is a **binary pass/fail per workflow (thresholded at 90% of substeps), then averaged over apps.**

### B) Open-source harness metric — "normalized artifact-averaged score"

`scripts/analyze_results.py` in the public repo computes a **continuous** score instead of the 90% binary threshold:

1. **Per test plan:** `percentage = score / full_points × 100`.
2. **Per artifact** (each `project × feature` is one artifact): average the percentages of all its test plans.
3. **Per model:** average across **all artifacts, each artifact weighted equally** (so a 10-step plan and a 3-step plan count the same once normalized).

   ```
   model_score = mean over artifacts( mean over test_plans( score / full_points × 100 ) )
   ```

The analyzer also reports two secondary views:
- **Weighted score** = `Σ score / Σ full_points` (bigger test plans count more).
- **Pass rate** = % of test plans that are *complete* passes (`score == full_points`).

Build/seeding failures enter all of these as explicit `0`.

> **Bottom line:** the public leaderboard number (A) is a *thresholded workflow-pass rate*; the open repo's analyzer (B) is a *continuous normalized average of points*. Both are legitimate ViBench scores derived from identical per-step judgments — just don't compare a number from one scheme against a number from the other.

---

## 6. Models evaluated & headline results

**Paper (test split, accuracy ± SE), 16 frontier models across 9 providers:**

| Rank | Model | Accuracy |
|---|---|---|
| 1 | GPT-5.3-Codex | **61.77 ± 4.71 %** |
| 2 | Claude Opus 4.6 | 57.57 ± 4.37 % |
| 3 | GPT-5.2 | 53.50 ± 5.07 % |
| 4 | Claude Sonnet 4.6 | 51.48 ± 4.64 % |
| … | Gemini 3.1 Pro | 32.03 ± 4.34 % |

Headline finding: even the **best model reaches only ~61.8%** on the held-out split — reliable end-to-end app building is still an open frontier.

**Public repo harness** (a living harness, scaffolds *newer* model names than the paper snapshot):
- *Open:* `deepseek_v4-pro`, `glm_5.1`, `minimax_m2.7`, `kimi_k2.6`
- *Closed:* `Opus_4_7`, `GPT_5.5`, `GPT_5.4_mini`, `GEMINI3_1_PRO`

The mismatch between paper and repo model lists indicates the GitHub harness has been updated past the paper's published run.

---

## 7. Known limitations (author-acknowledged)

- **Functional ≠ good code.** Passing the behavioral tests "does not imply maintainable, secure, or well-documented code."
- **Narrow tech surface.** Focused exclusively on React/Vite + Supabase, browser-based web apps. No mobile, native, CLI, data/ML, or other backends.
- **LLM-judge dependence.** Scores come from an autonomous browser agent; despite human-QA-aligned rules, it inherits LLM-grader variance (ephemeral UI elements, judgment calls on "minor" deviations).
- **Threshold sensitivity.** The 90% substep cutoff is a design choice — a workflow at 88% completion fails entirely under metric (A) even if mostly working.
- **Infra cost / fragility.** Each unit spins up its own Docker network; large sweeps can exhaust Docker's address pool (the repo documents a `default-address-pools` fix). Runs also have non-trivial $ cost (tracked per artifact and per evaluation).

---

## 8. One-paragraph summary

ViBench is Replit's open benchmark that measures whether AI agents can build *working* web apps from a plain-language PRD. A model builds each app in a Docker sandbox; an autonomous browser agent then runs the app and scores test plans step-by-step (all-or-nothing per step, fatal steps abort the plan). The **published score** is a workflow-pass accuracy — a workflow passes if ≥90% of its substeps succeed, an app's score is the % of its workflows that pass, and a model's score is the mean over 50 held-out apps (± standard error). The **open-source harness** additionally reports a continuous normalized score (mean of `points/full_points` per artifact, artifacts weighted equally). Top models top out near ~62%, and the authors caution that passing these behavioral tests says nothing about code quality, security, or maintainability.
