import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { orchestrateHookCommand } from "@harness/core";
import type { IAgentProvider, ITerminal, WorkflowRun } from "@harness/sdk";
import type { Registry } from "@harness/sdk/internal";
import type { Context } from "hono";
import { Hono } from "hono";
import { errorResponse, jsonBody, type Vars } from "./api.ts";
import { type StartRunBody, StartRunBodySchema } from "./protocol.ts";

export type RunDeps = Readonly<{
  registry: Registry;
  provider: IAgentProvider;
  terminal: ITerminal;
  home: string;
}>;

const startRun = async (c: Context<{ Variables: Vars }>, deps: RunDeps, body: StartRunBody) => {
  const log = c.get("log").child({ component: "runs" });
  const { workflow, workflowPath, inputs, cwd, name } = body;

  if (!existsSync(workflowPath) || !existsSync(cwd)) {
    return errorResponse(c, 400, "bad-request", "workflowPath and cwd must exist");
  }

  const id = `r-${randomBytes(4).toString("hex")}`;
  const runLog = log.child({ runId: id });
  // Saved before the agent starts: its first step is `orchestrate init`, which must find the run.
  const pending: WorkflowRun = {
    id,
    workflow,
    workflowPath,
    inputs,
    cwd,
    sessions: [],
    name: null,
    terminal: null,
    createdAt: new Date().toISOString(),
  };
  await deps.registry.addRun(pending);

  // A run whose agent never started is removed, so a failed start records nothing.
  const nameArg = name === undefined ? "" : ` --name ${name}`;
  const launched = await deps.provider
    .launch({
      cwd,
      prompt: `/orchestrate-v2 --workflow ${workflowPath} --inputs ${JSON.stringify(inputs)}${nameArg}`,
      env: { HARNESS_RUN_ID: id, HARNESS_HOME: deps.home },
      hookCommand: orchestrateHookCommand(),
    })
    .catch(async (error: unknown) => {
      await deps.registry.removeRun(id);
      throw error;
    });
  if (!launched.ok) {
    await deps.registry.removeRun(id);
    runLog.error(
      { err: String(launched.error) },
      "run not started: the agent session failed to launch",
    );
    return errorResponse(c, 502, "agent-failed", String(launched.error));
  }

  const { sessionId } = launched.value;
  const session = { agent: deps.provider.type, sessionId };
  await deps.registry.linkSession(id, session);
  await deps.registry.setTerminal(id, sessionId);
  const run = (await deps.registry.findRun(id)) ?? {
    ...pending,
    sessions: [session],
    terminal: sessionId,
  };
  runLog.info({ workflow, cwd, agent: deps.provider.type, sessionId }, "run started");
  return c.json({ run, attach: [...deps.terminal.attachCommand(sessionId)] }, 201);
};

// Mounted at /runs by app.ts. Chained, so each route's input and output types reach AppType.
export const runRoutes = (deps: RunDeps) =>
  new Hono<{ Variables: Vars }>().post("/", jsonBody(StartRunBodySchema), (c) =>
    startRun(c, deps, c.req.valid("json")),
  );
