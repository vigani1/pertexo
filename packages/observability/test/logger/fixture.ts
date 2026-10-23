import { context } from '@opentelemetry/api';

import type { DestinationStream } from 'pino';

import { parseObservabilityConfig } from '../../src/config.js';

export function captureDestination(): {
  destination: DestinationStream;
  records: Record<string, unknown>[];
} {
  const records: Record<string, unknown>[] = [];
  return {
    destination: {
      write(message: string): void {
        records.push(JSON.parse(message) as Record<string, unknown>);
      },
    },
    records,
  };
}

export function testConfig() {
  return parseObservabilityConfig({
    environment: 'test',
    logLevel: 'trace',
    serviceName: 'api',
    serviceVersion: '1.2.3',
  });
}

export function cleanPackagesObservabilityTestLoggerTestTsLoggerTestTsFixture() {
  context.disable();
}
