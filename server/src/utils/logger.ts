type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<Level, number> = {
  trace: 5,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};
const threshold = (process.env.LOG_LEVEL as Level) ?? 'info';

function emit(level: Exclude<Level, 'silent'>, scope: string, message: string, meta?: unknown) {
  if (ORDER[level] < ORDER[threshold]) return;
  const stamp = new Date().toISOString();
  const tag = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const line = `${tag} ${message}`;
  if (level === 'error') console.error(line, meta ?? '');
  else if (level === 'warn') console.warn(line, meta ?? '');
  else console.log(line, meta ?? '');
}

export function createLogger(scope: string) {
  return {
    trace: (message: string, meta?: unknown) => emit('trace', scope, message, meta),
    debug: (message: string, meta?: unknown) => emit('debug', scope, message, meta),
    info: (message: string, meta?: unknown) => emit('info', scope, message, meta),
    warn: (message: string, meta?: unknown) => emit('warn', scope, message, meta),
    error: (message: string, meta?: unknown) => emit('error', scope, message, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;

export const logger = createLogger('lensflow');
