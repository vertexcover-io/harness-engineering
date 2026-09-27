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
