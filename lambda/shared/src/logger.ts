type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  [key: string]: unknown;
}

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info') as LogLevel;
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'development';
const SERVICE = process.env.SERVICE_NAME ?? 'vitas-payments';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[LOG_LEVEL];
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (!shouldLog(level)) return;
  const entry = {
    level,
    message,
    service: SERVICE,
    environment: ENVIRONMENT,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  // Single console output per log line — structured JSON for CloudWatch Logs Insights
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](JSON.stringify(entry));
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info:  (message: string, fields?: LogFields) => emit('info',  message, fields),
  warn:  (message: string, fields?: LogFields) => emit('warn',  message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
