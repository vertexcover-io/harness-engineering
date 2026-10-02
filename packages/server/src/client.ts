import { harnessHome, type ILogger, noopLogger, type Result } from "@harness/sdk";
import type { ClientResponse } from "hono/client";
import { hc } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";
import type { AppType } from "./app.ts";
import { type ApiError, ErrorBodySchema, type StartRunRequest, socketPath } from "./protocol.ts";

export type HarnessClientOptions = Readonly<{ home?: string; log?: ILogger }>;

// The body a response carries on its 2xx statuses, as the server's routes declare it.
type SuccessBody<R> =
  R extends ClientResponse<infer Body, infer Status, "json">
    ? Status extends SuccessStatusCode
      ? Body
      : never
    : never;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// A non-JSON reply (a proxy, a crash mid-response) still comes back as an ApiError.
const replyError = (status: number, text: string, json: unknown): ApiError => {
  const body = ErrorBodySchema.safeParse(json);
  if (body.success) return body.data.error;
  return { code: "internal", message: `${status} ${text.trim().slice(0, 200)}`.trim() };
};

const unwrap = async <R extends ClientResponse<unknown, number, "json">>(
  pending: Promise<R>,
): Promise<Result<SuccessBody<R>, ApiError>> => {
  const res = await pending.catch(() => null);
  if (res === null)
    return { ok: false, error: { code: "internal", message: "server unreachable" } };
  const text = await res.text();
  const json = parseJson(text);
  return res.ok
    ? { ok: true, value: json as SuccessBody<R> }
    : { ok: false, error: replyError(res.status, text, json) };
};

// Bun's fetch reaches a Unix socket through a `unix` option its types don't declare.
const socketFetch = (socket: string, log: ILogger) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const start = Date.now();
    const url = input instanceof Request ? input.url : input.toString();
    const fields = { method: init?.method ?? "GET", path: new URL(url).pathname };
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const res = await fetch(input, { ...init, unix: socket } as any).catch((error: unknown) => {
      log.debug({ ...fields, socket, err: error }, "server not reachable on its socket");
      throw error;
    });
    // reqId matches the server's own line for this request in server.log.
    const reqId = res.headers.get("x-request-id") ?? undefined;
    log.debug(
      { ...fields, status: res.status, reqId, durationMs: Date.now() - start },
      "server request finished",
    );
    return res;
  }) as typeof fetch;

// One method per API call, named like the CLI command that makes it. Inputs and outputs are
// typed from the server's routes, so neither side restates the other's schemas.
export const createHarnessClient = ({
  home = harnessHome(),
  log = noopLogger,
}: HarnessClientOptions = {}) => {
  const api = hc<AppType>("http://harness", {
    fetch: socketFetch(socketPath(home), log.child({ component: "client" })),
  });
  return {
    health: () => unwrap(api.health.$get()),
    run: (body: StartRunRequest) => unwrap(api.runs.$post({ json: body })),
    view: (runId: string) => unwrap(api.runs[":id"].view.$get({ param: { id: runId } })),
  };
};

export type HarnessClient = ReturnType<typeof createHarnessClient>;
