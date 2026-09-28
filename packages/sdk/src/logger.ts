import * as z from "zod";

type LogFn = (fields: Record<string, unknown>, message?: string) => void;

export interface ILogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child(bindings: Record<string, unknown>): ILogger;
}

// Default for factories whose caller passes no logger.
export const noopLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error", "silent"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

const LEVELS = LogLevelSchema.options;

// An Error serialises to {} with JSON.stringify, which would drop the stack a failure log needs.
const serialize = (value: unknown): unknown =>
  value instanceof Error
    ? {
        message: value.message,
        stack: value.stack,
        ...(value.cause === undefined ? {} : { cause: serialize(value.cause) }),
      }
    : value;

export type JsonLoggerOptions = Readonly<{
  level: LogLevel;
  write?: (line: string) => void;
  bindings?: Record<string, unknown>;
}>;

const writeLine = (
  options: JsonLoggerOptions,
  lineLevel: Exclude<LogLevel, "silent">,
  fields: Record<string, unknown>,
  message: string | undefined,
): void => {
  if (LEVELS.indexOf(lineLevel) < LEVELS.indexOf(options.level)) return;
  const entries = Object.entries({ ...options.bindings, ...fields }).map(([key, value]) => [
    key,
    serialize(value),
  ]);
  const line = JSON.stringify({ level: lineLevel, ...Object.fromEntries(entries), msg: message });
  if (options.write === undefined) process.stderr.write(`${line}\n`);
  else options.write(line);
};

// A logger for scripts that have no pino: one JSON line per call, on stderr by default.
export const jsonLogger = (options: JsonLoggerOptions): ILogger => ({
  debug: (fields, message) => writeLine(options, "debug", fields, message),
  info: (fields, message) => writeLine(options, "info", fields, message),
  warn: (fields, message) => writeLine(options, "warn", fields, message),
  error: (fields, message) => writeLine(options, "error", fields, message),
  child: (more) => jsonLogger({ ...options, bindings: { ...options.bindings, ...more } }),
});
