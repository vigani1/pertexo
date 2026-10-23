import type { TelemetryLifecycle } from '@pertexo/observability';

import type { FixtureLogCapture } from './contract.js';

export function createFixtureLogCapture(): FixtureLogCapture {
  const lines: string[] = [];
  const capture = (
    event: string,
    fields: Readonly<Record<string, unknown>> | undefined,
    error: unknown,
  ): void => {
    let fieldsText = '';
    if (fields !== undefined) {
      try {
        fieldsText = JSON.stringify(fields);
      } catch {
        fieldsText = '[unserializable fields]';
      }
    }
    let errorText;
    if (error === undefined) {
      errorText = '';
    } else if (error instanceof Error) {
      errorText = error.message;
    } else if (typeof error === 'string') {
      errorText = error;
    } else {
      errorText = '[unserializable error]';
    }
    lines.push(`${event} ${fieldsText} ${errorText}`.trim());
  };
  return Object.freeze({
    logger: Object.freeze({
      debug: capture,
      error: capture,
      fatal: capture,
      info: capture,
      trace: capture,
      warn: capture,
    }),
    readText: () => lines.join('\n'),
  });
}

export const telemetry: TelemetryLifecycle = {
  enabled: false,
  started: false,
  start: () => undefined,
  shutdown: () => Promise.resolve(),
};
