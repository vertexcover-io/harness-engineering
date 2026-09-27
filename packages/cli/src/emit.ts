import { Command } from "@commander-js/extra-typings";
import type { EmitInput, Event, JsonValue, Result } from "@harness/core";
import { apiErrorText, commandLog, ensureServer, fail, harnessClient } from "./client.ts";
import { NO_RUN_MESSAGE, resolveRunId } from "./run.ts";

// Stores events through the harness server, which picks the run's event store (ADR 0001).
// Never throws on an HTTP error: an error reply comes back as { ok: false, error: "CODE: MESSAGE" }.
export const emitEvent = async (
  runId: string,
  input: EmitInput,
  client = harnessClient(),
): Promise<Result<Event>> => {
  const result = await client.emit(runId, input);
  if (!result.ok) return { ok: false, error: apiErrorText(result.error) };
  // Hono's recursive JSON type is too deep for TypeScript to compare with Event directly.
  return { ok: true, value: result.value.event as unknown as Event };
};

const parsePayload = (text: string): Result<JsonValue, Error> => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: new Error("--payload is not valid JSON", { cause: error }) };
  }
};

export const emitCommand = () =>
  new Command("emit")
    .description("Add an event to the current run's event log")
    .argument("<type>", "event type, e.g. custom.review.note")
    .requiredOption("--source <name>", "who sent the event, e.g. the skill's name")
    .option("--payload <json>", "event payload as JSON", "{}")
    .option("--run-id <id>", "run id (defaults to $HARNESS_RUN_ID)")
    .option("--node-id <id>", "node the event belongs to; needs --node-run-id")
    .option("--node-run-id <id>", "node run the event belongs to; needs --node-id")
    .option("--stage <name>", "stage the event belongs to")
    .option("--id <id>", "event id; a repeated id returns the event stored first")
    .action(async (type, opts) => {
      const runId = resolveRunId(opts.runId);
      if (runId === null) return fail(NO_RUN_MESSAGE);
      const payload = parsePayload(opts.payload);
      if (!payload.ok) return fail(payload.error);

      await ensureServer();
      const result = await emitEvent(runId, {
        type,
        payload: payload.value,
        source: opts.source,
        id: opts.id,
        nodeId: opts.nodeId,
        nodeRunId: opts.nodeRunId,
        stage: opts.stage,
      });
      if (!result.ok) return fail(result.error);
      commandLog("emit").info({ runId, type, seq: result.value.seq }, "event stored");

      console.log(JSON.stringify(result.value));
    });
