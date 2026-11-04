// @ts-check
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { diag, DiagLogLevel, trace } from '@opentelemetry/api';
import { createOpenTelemetrySdk } from '@pertexo/observability/startup';

// Exercise main's real static imports before telemetry and its later logging import.
import '../dist/main.js';
const collector = createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
});
collector.listen(0, '127.0.0.1');
await once(collector, 'listening');
const address = collector.address();
if (address === null || typeof address === 'string')
  throw new Error('Missing collector address');
/** @type {import('@pertexo/observability/startup').ObservabilityConfig & {otlpHttpEndpoint:string}} */
const settings = {
  serviceName: 'worker',
  serviceVersion: 'test',
  environment: 'test',
  logLevel: 'info',
  otlpHeaders: {},
  otlpHttpEndpoint: `http://127.0.0.1:${address.port}`,
};
// Expose Node's real module cache to the SDK's preload diagnostic in this ESM process.
globalThis.require = createRequire(
  import.meta.resolve('@pertexo/observability'),
);
diag.setLogger(
  {
    warn: (...args) =>
      console.error(
        JSON.stringify({
          event: 'telemetry.startup_warning',
          message: args.map(String).join(' '),
        }),
      ),
    error: (...args) =>
      console.error(
        JSON.stringify({
          event: 'telemetry.startup_error',
          message: args.map(String).join(' '),
        }),
      ),
    info: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  },
  DiagLogLevel.WARN,
);
process.env.OTEL_LOGS_EXPORTER = 'none';
const sdk = createOpenTelemetrySdk(settings);
try {
  sdk.start();
  const { createStructuredLogger } = await import('@pertexo/observability');
  trace.getTracer('startup-probe').startActiveSpan('startup.probe', (span) => {
    createStructuredLogger(settings).info('startup.probe');
    span.end();
  });
} finally {
  await sdk.shutdown();
  await new Promise((resolve, reject) =>
    collector.close((error) =>
      error === undefined ? resolve(undefined) : reject(error),
    ),
  );
}
