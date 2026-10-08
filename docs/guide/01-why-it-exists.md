# Why Yok exists

Yok is the second version of our harness. We built it because the first version, a set of skill files that told the agent how to run a whole pipeline, was not reliable enough to trust. This page is the story as Ritesh told it to the team when Yok was ready to try: what a harness is, what went wrong with the first one, what we borrowed from other projects, and what we were trying to get.

## What a harness is

A model on its own is just intelligence. A harness is that intelligence plus tools plus a method for using them in a particular order, so the result is more predictable. Claude Code is itself a harness: it has sub-agents, background jobs, tool calls, and a system prompt that says how to use them. That is why you can ask it to build a feature and it writes tests without being told.

Our harness is one more layer on top of that. It is an opinionated way to build software in a mid-sized team, for a task that starts as a ticket and ends as a pull request. Design before plan, plan before code, proof before PR. The opinion is not for every kind of work. It is for the work where you already know what to build and need it built the same careful way every time.

The reason to adopt one for a whole team, instead of each engineer collecting their own skill files, is the quality bar. One person's code review skill is strict on security and another's is not. One person's tests check behaviour and another's test nothing. A shared harness encodes one policy, so every PR clears the same bar.

## What went wrong with version one

Version one was a skill called `orchestrate` that called the other skills in order. The pipeline lived in prose. The agent read that prose, decided which stage came next, judged whether a stage had finished, and typed every bookkeeping command itself.

After two months of use by a client's team and by us, four problems were clear.

**It was flaky.** Runs blocked in random places. The context grew until the agent lost track of where it was. Sometimes it just stopped, and when asked why, it had no answer. Things that should have been fast took a long time.

**It could not be changed per task.** The order of stages was hard-coded in the skill. If a ticket did not need a stage, you could ask in the prompt, and it might or might not listen.

**You had no control over the agent.** After planning, you want the context cleared. After coding, cleared again. After testing, cleared again. That saves time and money and keeps the agent sharp. Version one could not do it. The only lever on Claude Code is its hooks, and hooks alone are not enough.

**It was one agent, all the way through.** If the harness ran on Claude, everything ran on Claude. There was no clean way to put one stage on Codex, or on a cheaper model, or on an open-source one.

Behind all four was a single cause: no program ran the pipeline. The model was the scheduler, the checker, and the process manager, and nothing enforced any of that. One skipped sentence became a stopped run or a missing record. The two long runs we audited afterwards, written up in [docs/research/challenges.md](../research/challenges.md), found 55 confirmed problems with that root. Six could ship a wrong result silently with nobody watching.

## What we borrowed

Two open-source projects shaped the design. Neither was adopted whole.

**Archon** is a harness builder, not a harness. You describe a workflow in a file and it runs it. That framing stuck: Yok is a builder too, and its engine knows nothing about software. You could run a sales pipeline on it. What we did not take was Archon's execution model. It runs prompts in order through the agent SDKs, with no person in the loop. That is automation, not an engineer's tool.

**AWS's AIDLC** runs inside Claude Code the way our version one did, but with a split we had been missing. A skill handles the conversation. A script, `orchestrate.ts`, holds the workflow. The skill does one step, then asks the script "I am done, what is next?", and the script answers. Decisions live in code; the agent only performs. That loop is the heart of Yok. What we did not take was the rest: 33 stages, 33 hooks, and instructions composed at run time from agents, scopes, and protocols spread across many markdown files. It was hard to tell what caused what, and it was far more than the job needed.

Yok is Archon's workflow file, AIDLC's step loop, and the skills we already had, with one more thing neither of them has: every action the engine or the agent takes is written to an event log, and the run's state is computed from that log.

## What we were trying to get

**A run that does not block.** The way Ritesh uses it: hand it a task, walk away, and know it will reach a PR. It will run the tests every time. It will drive the browser to prove the feature every time. Not most of the time. Every time.

**A workflow you can shape.** Skip a stage for one ticket. Add a stage for one project. Loop QA until it passes. Clear the context between stages. Put one stage on a different model. All of that is a line in a YAML file now, not a change to a skill.

**A record you can read.** Every start, finish, rejection, and hook call is an event. When a run does something odd, the answer is in `event.jsonl`, not in a transcript you have to scroll.

**A system a project can extend without forking.** A project adds a Jira reference to the ticket fetcher, replaces one script, or reacts to events with its own subscribers. The shipped skills stay shared.

## What is not here yet

Yok was built in about ten days of part-time work and has been used since to build itself. It is not finished. The parts planned but not built, as of this writing:

- Nodes run one at a time. Two nodes with no dependency between them still run in sequence. The `mode` field on a stage, `inline` or `subagent`, is parsed but nothing reads it yet. A detached mode, running a stage as its own headless session, is also planned.
- `scopes` and `protocols` in a stage's frontmatter are parsed and unused. They come from AIDLC: a scope would set how much rigour a run applies, a protocol would load a shared rule such as a writing style into every stage without each skill naming it.
- Only Claude and Codex have providers. The agent type enum also lists pi and opencode.
- An unattended "auto" mode, where a run tells you over Slack that a ticket is too complex for it and stops, instead of asking questions.
- The shipped skills were ported from version one and have not been reworked yet. The engine is what to trust first; the quality of what each stage writes is the next job.

## What Yok is not

It is not a replacement for Claude Code or Codex. It launches them and talks to them through their own hooks and terminals.

It is not a CI system or a durable cloud runtime. It runs on one laptop, for one person's task, with a browser page to watch.

It is not opinionated about your code. It is opinionated about the order of work.

Next: [What it is, in 60 seconds](02-what-it-is.md).
