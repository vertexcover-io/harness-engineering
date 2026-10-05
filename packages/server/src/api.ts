import { zValidator } from "@hono/zod-validator";
import type { ILogger } from "@yok/sdk";
import type { Context } from "hono";
import * as z from "zod";
import type { ErrorBody, ErrorCode } from "./protocol.ts";

// Set by the request logger in app.ts: a logger bound to this request's reqId.
export type Vars = { log: ILogger };

export const errorResponse = (
  c: Context,
  status: 400 | 404 | 409 | 500 | 502,
  code: ErrorCode,
  message: string,
) => c.json({ error: { code, message } } satisfies ErrorBody, status);

// Checks a JSON body against its schema; a body that fails is a 400 in the API's error shape.
export const jsonBody = <T extends z.ZodType>(schema: T) =>
  zValidator("json", schema, (result, c) =>
    result.success
      ? undefined
      : errorResponse(c, 400, "bad-request", z.prettifyError(result.error)),
  );
