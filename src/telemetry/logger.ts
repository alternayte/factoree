import type { Redactor } from "./redaction.js";

export type LogFields = {
  tenant_id?: string;
  project_id?: string;
  run_id?: string;
  linear_issue?: string;
  workflow_id?: string;
  step?: string;
  sprite_id?: string;
  [key: string]: unknown;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level: string;
  redactor: Redactor;
  sink?: (line: string) => void;
  now?: () => Date;
}

const toLevel = (value: string): LogLevel =>
  value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";

export const createLogger = (options: LoggerOptions): Logger => {
  const level = toLevel(options.level);
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const build = (base: LogFields): Logger => {
    const write = (entryLevel: LogLevel, message: string, fields?: LogFields): void => {
      if (ORDER[entryLevel] < ORDER[level]) return;
      const entry = options.redactor.redact({
        time: now().toISOString(),
        level: entryLevel,
        message,
        ...base,
        ...(fields ?? {}),
      });
      sink(JSON.stringify(entry));
    };

    return {
      debug: (message, fields) => write("debug", message, fields),
      info: (message, fields) => write("info", message, fields),
      warn: (message, fields) => write("warn", message, fields),
      error: (message, fields) => write("error", message, fields),
      child: (fields) => build({ ...base, ...fields }),
    };
  };

  return build({});
};
