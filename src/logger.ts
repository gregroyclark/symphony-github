export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const weights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function createLogger(level: LogLevel = "info"): Logger {
  function write(nextLevel: LogLevel, message: string, context: Record<string, unknown> = {}) {
    if (weights[nextLevel] < weights[level]) return;
    const row = {
      ts: new Date().toISOString(),
      level: nextLevel,
      message,
      ...context
    };
    const line = JSON.stringify(row);
    if (nextLevel === "error" || nextLevel === "warn") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context)
  };
}
