# Yok

Yok walks an AI coding agent through a workflow of stages, from a task to an open pull request. It keeps each run's history, so any step can be checked, resumed or audited.

## Workflows and runs

**Workflow**:
A named graph of nodes that says what a run does and in what order.
_Avoid_: Pipeline, flow

**Run**:
One execution of a workflow, from its start to its end, with its own inputs, history and status.
_Avoid_: Job, execution, task run

**Run id**:
The unique id a run gets when the server registers it.

**Run name**:
The short readable name a run takes at init, which names its folder.
_Avoid_: Spec name

**Input**:
A value given to a run when it starts, declared by the workflow.

**Registry**:
The machine-wide list of runs, shared by the server and the orchestrate commands.

**Task**:
The work a run is asked to do, taken from a prompt or a ticket.
_Avoid_: Request (for the fetched task)

**Ticket**:
An issue in a tracker (Linear or Asana) that a run fetches its task from.

## Nodes

**Node**:
One step in a workflow's graph, of one node type.
_Avoid_: Step (for the declaration), job

**Node run**:
One execution of a node inside a run. A node inside a loop gets a new node run on each iteration.

**Agent node**:
A node the agent carries out, either as a stage or from a plain prompt.

**Stage node**:
An agent node that runs a stage.

**Exec node**:
A node that runs a script or a module function, not the agent.

**Context node**:
A node that gives the agent a fresh context, by starting a new session or compacting the one it has.

**Loop node**:
A node that repeats its child nodes until a condition holds or it hits its iteration limit.

**Iteration**:
One pass through a loop node's children.

**Switch node**:
A node that picks one case of child nodes by the value of an expression.

**Include node**:
A node that runs another workflow inside this one.

**Wait node**:
A node that pauses the run for a set time.

**Always node**:
A node that still starts after an earlier node in its scope failed.

**Skipped**:
A node run the engine passed over, with the reason: its condition was false, a dependency was skipped, or no switch case matched.

## Stages

**Stage**:
A skill that can run as a node, declaring its inputs, outputs, artifacts and verifiers.
_Avoid_: Phase, step

**Skill**:
A packaged set of instructions an agent loads. A skill becomes a stage when it declares a stage contract.

**Artifact**:
A file a stage produces for later stages to consume, such as a design or a plan.
_Avoid_: Output file, deliverable

**Produces / consumes**:
The artifacts a stage writes and the artifacts it needs before it can start.

**Blocked**:
A run whose next stage cannot start because an artifact it consumes does not exist yet.

**Verifier**:
A check a stage declares that must pass before the stage's node can finish.

**Finding**:
One problem a verifier or reviewer reports, optionally pinned to a file and line.

**Rejected**:
A finish attempt a verifier turned down, which sends the agent back to fix its findings.

**Extension**:
A project's change to a shipped skill: its own skill text, or references added, replaced or extended.

**Reference**:
A supporting file a skill lists and loads on demand.

**Variable**:
A named value a workflow's stage node passes to its stage.

## Stepping through a run

**Orchestrate**:
The skill and script a session uses to walk a run one node at a time.

**Step**:
The node run that `next` hands the session, which it then carries out and reports back on with `done`.
_Avoid_: Task, turn

**Next**:
Asking the run for the step it is at now.

**Done**:
Reporting how a step ended, with its output or its error.

## Agents and sessions

**Agent**:
The coding tool that does the work: Claude or Codex.
_Avoid_: Bot, model (for the tool)

**Session**:
One conversation of an agent working on a run. A run can replace its session over time.

**Active session**:
A session working on a run right now.

**Tier**:
A named level of model power, such as `fast` or `deep`, that a node or stage asks for.
_Avoid_: Model level

**Model switch**:
Moving a run's session onto another model between stages, because the next node's tier needs it.

**Limit wait**:
A run pausing until the agent's usage limit resets, then resuming the session.

**Stuck**:
An agent the Stop hook sent back too many times in a row, so yok let its turn end.

## Events and state

**Event**:
One recorded fact about a run, such as a node starting or a comment arriving, in order.

**Event log**:
A run's full history, as an ordered list of events.
_Avoid_: Journal, history file

**State**:
A run's current picture, built by folding its events. It is never the history.

**Event handler**:
A function that folds one event type into the run's state.
_Avoid_: Reducer, subscriber

**Custom state**:
Values a subscriber or skill keeps in a run's state between calls, under its own key.

## Subscribers and hooks

**Subscriber**:
Code the config or workflow attaches to an event type, called once after that event is stored.
_Avoid_: Run hook, event handler, listener

**Blocking subscriber**:
A subscriber the run waits on before it moves on.

**Detached subscriber**:
A subscriber that runs on its own, without holding up the run.

**Agent hook**:
A hook the agent itself fires at points in its session (start, tool use, stop) that yok answers. "Hook" means only this.
_Avoid_: Run hook

**Stop hook**:
The agent hook that decides whether the agent may end its turn or must go back to work.

## Workspace and project

**Config**:
A project's yok settings: packages, commands, environments, tiers, extensions and subscribers.

**Workspace**:
The folder where a run makes its changes, holding one or more repositories.

**Layout**:
How a workspace holds its code: `mono` (one repository) or `multi` (several).

**Package**:
A part of a project the config names, with its own path and commands.

**Baseline**:
The project's test and quality numbers taken before a run changes anything, for later comparison.

**Environment**:
A named target a run verifies its change against, with its own commands.

**Doctor**:
The check that a machine, repository and config have everything a run needs.

## People and feedback

**Comment**:
A note a person leaves on a run's artifact, which yok types into the agent's session.
_Avoid_: Review comment (for PR review comments)

**Question**:
Something the agent asks the person and waits on.

**Notifier**:
The built-in subscriber that posts a run's progress to a chat thread.

**Retro**:
The stage that audits a finished run for yok defects.
_Avoid_: Post-mortem

## Relationships

- A **Workflow** has many **Nodes**; a **Run** executes one **Workflow** and holds one **Node run** per node it reaches.
- A **Stage node** runs exactly one **Stage**; a **Stage** is a **Skill** with a stage contract.
- A **Stage** **produces** and **consumes** **Artifacts**; a missing consumed **Artifact** makes the run **Blocked**.
- A **Verifier** can **Reject** a **Done**; each rejection carries **Findings**.
- A **Run** stores every change as an **Event**; **Event handlers** fold events into **State**; **Subscribers** react to events after they are stored.
- **Agent hooks** belong to the **Agent's** session, not to the run's events.

## Flagged ambiguities

- "Hook" meant two things: hooks the agent fires and hooks the run calls on events. Resolved: **Agent hook** and **Subscriber**.
- "Pipeline" and "workflow" were used for the same thing. Resolved: **Workflow**.
- The orchestrate help text calls a run's name its "spec name". Resolved: **Run name**.
- "Event handler" and "subscriber" both react to events. Resolved: an **Event handler** changes state; a **Subscriber** only reacts.
