type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = parseLogLevel(process.env.ROSSBOT_LOG_LEVEL) ?? "info";

export function logDebug(message: string, context?: LogContext): void {
  writeLog("debug", message, context);
}

export function logInfo(message: string, context?: LogContext): void {
  writeLog("info", message, context);
}

export function logWarn(message: string, context?: LogContext): void {
  writeLog("warn", message, context);
}

export function logError(message: string, context?: LogContext): void {
  writeLog("error", message, context);
}

export function errorContext(error: unknown): LogContext {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }
  return { errorMessage: String(error) };
}

function writeLog(level: LogLevel, message: string, context: LogContext = {}): void {
  if (levels[level] < levels[configuredLevel]) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...sanitizeContext(context),
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function sanitizeContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [key, shouldRedact(key) ? "[redacted]" : normalizeValue(value)]),
  );
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function shouldRedact(key: string): boolean {
  return /token|secret|password|authorization/i.test(key);
}

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  return undefined;
}
