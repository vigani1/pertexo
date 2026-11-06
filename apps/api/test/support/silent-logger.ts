import type { StructuredLogger } from '@pertexo/observability/server';

/** For wiring that requires a logger where the test does not read the logs. */
export const silentLogger: StructuredLogger = Object.freeze({
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
});
