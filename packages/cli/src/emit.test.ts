import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@harness/core";
import { socketPath } from "@harness/server";
import { createHarnessClient } from "@harness/server/client";
import { emitEvent } from "./emit.ts";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const clientFor = (reply?: () => Response) => {
  const home = mkdtempSync(join(tmpdir(), "harness-emit-"));
  if (reply !== undefined) {
    const server = Bun.serve({ unix: socketPath(home), fetch: reply });
    stops.push(() => server.stop(true));
  }
  return createHarnessClient({ home });
};

const input = { type: "custom.x.y", payload: {}, source: "cli" };

describe("emitEvent", () => {
  test("SC29: a 2xx reply returns the stored event", async () => {
    const event: Event = {
      schemaVersion: 1,
      seq: 2,
      id: "e-1",
      ts: new Date().toISOString(),
      runId: "r-1",
      ...input,
    };
    const client = clientFor(() => Response.json({ event }));

    expect(await emitEvent("r-1", input, client)).toEqual({ ok: true, value: event });
  });

  test("SC29: an error reply returns CODE: MESSAGE instead of throwing", async () => {
    const client = clientFor(() =>
      Response.json(
        { error: { code: "not-found", message: "run r-1 not found" } },
        { status: 404 },
      ),
    );

    expect(await emitEvent("r-1", input, client)).toEqual({
      ok: false,
      error: "not-found: run r-1 not found",
    });
  });

  test("SC29: no server returns an internal error instead of throwing", async () => {
    expect(await emitEvent("r-1", input, clientFor())).toEqual({
      ok: false,
      error: "internal: server unreachable",
    });
  });
});
