import { hostname } from "node:os";
import pino from "pino";

export type LogBase = Record<string, unknown> & { service: string };

type CreateLoggerOptions = {
  level?: pino.LevelWithSilent;
  destination?: pino.DestinationStream;
};

const isValidLevel = (value: string): value is pino.LevelWithSilent =>
  value === "silent" || value in pino.levels.values;

// The fallback that applies when the caller passes none: production quiets to info,
// test silences entirely, everything else stays at debug.
const FALLBACK_BY_ENV: Record<string, pino.LevelWithSilent> = {
  production: "info",
  test: "silent",
};

// LOG_LEVEL wins over everything; a bad value warns once and falls back.
export const resolveLevel = (
  env: NodeJS.ProcessEnv,
  fallback: pino.LevelWithSilent = FALLBACK_BY_ENV[env.NODE_ENV ?? ""] ?? "debug",
): pino.LevelWithSilent => {
  const raw = env.LOG_LEVEL;
  if (raw === undefined || raw.trim() === "") return fallback;
  if (isValidLevel(raw)) return raw;
  console.warn(`Invalid LOG_LEVEL "${raw}", falling back to "${fallback}"`);
  return fallback;
};

export const createLogger = (base: LogBase, opts?: CreateLoggerOptions): pino.Logger => {
  const options: pino.LoggerOptions = {
    level: opts?.level ?? resolveLevel(process.env),
    // pino's `base` replaces its own {pid, hostname} default rather than merging with it, so
    // both are restated here: without them two processes writing one stream are indistinguishable.
    base: { pid: process.pid, hostname: hostname(), ...base },
    redact: {
      paths: [
        "token",
        "authorization",
        "*.token",
        "req.headers.authorization",
        "password",
        "secret",
      ],
      censor: "[Redacted]",
    },
  };
  return opts?.destination ? pino(options, opts.destination) : pino(options);
};

export type CapturedLine = Record<string, unknown> & {
  readonly msg: string;
  readonly level: number;
};

export type CaptureLogger = {
  readonly log: pino.Logger;
  readonly lines: readonly CapturedLine[];
  readonly at: (level: pino.Level) => readonly CapturedLine[];
};

// Collects every line at debug and below, for tests to assert against.
export const captureLogger = (): CaptureLogger => {
  const lines: CapturedLine[] = [];
  const log = createLogger(
    { service: "harness-test" },
    {
      level: "debug",
      destination: {
        write: (line: string) => {
          lines.push(JSON.parse(line) as CapturedLine);
        },
      },
    },
  );
  return {
    log,
    lines,
    at: (level) => lines.filter((line) => line.level === pino.levels.values[level]),
  };
};
