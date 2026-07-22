export type LogLevel = "debug" | "info" | "warn" | "error";

const REDACTED = "[redacted]";

/**
 * Keys whose *values* are never safe to log: credentials, per-command
 * environment (which carries the caller's secrets), and raw request headers.
 */
const REDACTED_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "token",
  "sandbox_broker_token",
  "bearer",
  "secret",
  "password",
  "env",
  "environment",
  "dataBase64",
]);

function redactValue(key: string, value: unknown, depth: number): unknown {
  if (REDACTED_KEYS.has(key.toLowerCase())) {
    // For env-like maps keep the key names, drop every value.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value as object).map((k) => [k, REDACTED]));
    }
    return REDACTED;
  }
  return redact(value, depth + 1);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      redactValue(key, entry, depth),
    ]),
  );
}

/** Renders one structured, redacted log line. Exported so tests can assert on it. */
export function formatLogLine(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    level,
    msg: message,
    ...(redact(fields) as Record<string, unknown>),
  });
}

export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVELS[level];
  const emit = (lineLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[lineLevel] < threshold) return;
    // stderr only: stdout stays free for anything that needs a clean channel.
    console.error(formatLogLine(lineLevel, message, fields));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
