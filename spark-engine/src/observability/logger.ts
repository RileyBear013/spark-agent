/**
 * Small logging seam shared by the standalone engine modules.
 *
 * The desktop host can inject its own logger when embedding the engine. The
 * CLI default writes diagnostics to stderr so model output on stdout remains
 * machine-readable.
 */
export interface RuntimeLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export const NULL_RUNTIME_LOGGER: RuntimeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_ORDER: Readonly<Record<Exclude<RuntimeLogLevel, 'silent'>, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/** Creates the default stderr logger used by CLI-owned environments. */
export function createRuntimeLogger(
  namespace: string,
  options: {
    readonly level?: RuntimeLogLevel
    readonly write?: (line: string) => void
  } = {},
): RuntimeLogger {
  const threshold = options.level ?? readRuntimeLogLevel()
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`))
  const emit = (level: Exclude<RuntimeLogLevel, 'silent'>, message: string): void => {
    if (threshold === 'silent' || LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return
    write(`[spark:${namespace}] ${level}: ${message}`)
  }
  return {
    debug: (message) => {
      emit('debug', message)
    },
    info: (message) => {
      emit('info', message)
    },
    warn: (message) => {
      emit('warn', message)
    },
    error: (message) => {
      emit('error', message)
    },
  }
}

function readRuntimeLogLevel(): RuntimeLogLevel {
  const configured = process.env.SPARK_LOG_LEVEL
  if (
    configured === 'debug' ||
    configured === 'info' ||
    configured === 'warn' ||
    configured === 'error' ||
    configured === 'silent'
  ) {
    return configured
  }
  return 'warn'
}
