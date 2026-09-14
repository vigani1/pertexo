import { describe, expect, it, vi } from 'vitest';

import { parseObservabilityConfig } from '../src/config.js';
import {
  createNodeInstrumentations,
  createTelemetryLifecycle,
  createTelemetryResource,
  METRIC_EXPORT_INTERVAL_MILLISECONDS,
  METRIC_EXPORT_TIMEOUT_MILLISECONDS,
  type TelemetrySdk,
  type TelemetrySdkFactory,
} from '../src/telemetry.js';

function disabledConfig() {
  return parseObservabilityConfig({
    environment: 'test',
    serviceName: 'api',
    serviceVersion: '1.0.0',
  });
}

function enabledConfig() {
  return parseObservabilityConfig({
    environment: 'test',
    otlpHeaders: { authorization: 'Bearer collector-token' },
    otlpHttpEndpoint: 'http://127.0.0.1:4318/otlp',
    serviceName: 'worker',
    serviceVersion: '1.0.0',
  });
}

function sdkHarness(): {
  factory: TelemetrySdkFactory;
  forceFlush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  sdk: TelemetrySdk;
  shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>;
  start: ReturnType<typeof vi.fn<() => void>>;
} {
  const start = vi.fn<() => void>();
  const forceFlush = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const shutdown = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const sdk = { forceFlush, shutdown, start };
  const factory = vi.fn<TelemetrySdkFactory>(() => sdk);
  return { factory, forceFlush, sdk, shutdown, start };
}

describe('createNodeInstrumentations', () => {
  it('constructs only the reviewed application instrumentation set', () => {
    const instrumentations = createNodeInstrumentations();

    expect(
      instrumentations.map(({ instrumentationName }) => instrumentationName),
    ).toEqual([
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-undici',
      '@opentelemetry/instrumentation-nestjs-core',
      '@opentelemetry/instrumentation-pino',
      '@opentelemetry/instrumentation-pg',
      '@opentelemetry/instrumentation-host-metrics',
      '@opentelemetry/instrumentation-runtime-node',
    ]);
  });
});

describe('createTelemetryResource', () => {
  it('uses an opaque per-writer identity without process or host attributes', () => {
    const resource = createTelemetryResource(
      enabledConfig(),
      '00000000-0000-4000-8000-000000000001',
    );

    expect(resource.attributes).toMatchObject({
      'deployment.environment.name': 'test',
      'service.instance.id': '00000000-0000-4000-8000-000000000001',
      'service.name': 'worker',
      'service.version': '1.0.0',
    });
    expect(resource.attributes).not.toHaveProperty('process.pid');
    expect(resource.attributes).not.toHaveProperty('host.name');
  });
});

describe('metric export timing', () => {
  it('keeps the qualified cadence and request timeout explicit', () => {
    expect(METRIC_EXPORT_INTERVAL_MILLISECONDS).toBe(60_000);
    expect(METRIC_EXPORT_TIMEOUT_MILLISECONDS).toBe(30_000);
  });
});

describe('createTelemetryLifecycle', () => {
  it('does not construct or start an SDK when exporting is disabled', async () => {
    const harness = sdkHarness();
    const telemetry = createTelemetryLifecycle(
      disabledConfig(),
      harness.factory,
    );

    telemetry.start();
    await telemetry.shutdown();

    expect(telemetry.enabled).toBe(false);
    expect(telemetry.started).toBe(false);
    expect(harness.factory).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.shutdown).not.toHaveBeenCalled();
  });

  it('constructs an enabled SDK without starting network activity', async () => {
    const harness = sdkHarness();
    const config = enabledConfig();
    const telemetry = createTelemetryLifecycle(config, harness.factory);

    expect(telemetry.enabled).toBe(true);
    expect(telemetry.started).toBe(false);
    expect(harness.factory).toHaveBeenCalledOnce();
    expect(harness.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        otlpHeaders: { authorization: 'Bearer collector-token' },
        otlpHttpEndpoint: 'http://127.0.0.1:4318/otlp',
        serviceName: 'worker',
      }),
    );
    expect(harness.start).not.toHaveBeenCalled();

    await telemetry.shutdown();
    expect(harness.shutdown).not.toHaveBeenCalled();
  });

  it('starts and shuts down the SDK idempotently', async () => {
    const harness = sdkHarness();
    const telemetry = createTelemetryLifecycle(
      enabledConfig(),
      harness.factory,
    );

    telemetry.start();
    telemetry.start();
    expect(telemetry.started).toBe(true);
    expect(harness.start).toHaveBeenCalledOnce();
    await telemetry.flush?.();
    expect(harness.forceFlush).toHaveBeenCalledOnce();

    const firstShutdown = telemetry.shutdown();
    const secondShutdown = telemetry.shutdown();
    expect(firstShutdown).toBe(secondShutdown);
    await firstShutdown;
    expect(telemetry.started).toBe(false);
    expect(harness.shutdown).toHaveBeenCalledOnce();
    expect(() => {
      telemetry.start();
    }).toThrow('Telemetry cannot be restarted after shutdown');
  });

  it('cleans up an SDK whose start was attempted and preserves the start failure', async () => {
    const harness = sdkHarness();
    const startFailure = new Error('partial SDK start');
    harness.start.mockImplementationOnce(() => {
      throw startFailure;
    });
    const telemetry = createTelemetryLifecycle(
      enabledConfig(),
      harness.factory,
    );

    expect(() => {
      telemetry.start();
    }).toThrow(startFailure);
    expect(telemetry.started).toBe(false);
    expect(() => {
      telemetry.start();
    }).toThrow(startFailure);
    expect(harness.start).toHaveBeenCalledOnce();

    const firstShutdown = telemetry.shutdown();
    const secondShutdown = telemetry.shutdown();
    expect(firstShutdown).toBe(secondShutdown);
    await firstShutdown;
    expect(harness.shutdown).toHaveBeenCalledOnce();
    expect(() => {
      telemetry.start();
    }).toThrow('Telemetry cannot be restarted after shutdown');
  });

  it('caches a synchronously throwing SDK shutdown before invoking it', async () => {
    const harness = sdkHarness();
    const shutdownFailure = new Error('synchronous shutdown failed');
    harness.shutdown.mockImplementationOnce(() => {
      throw shutdownFailure;
    });
    const telemetry = createTelemetryLifecycle(
      enabledConfig(),
      harness.factory,
    );
    telemetry.start();

    const firstShutdown = telemetry.shutdown();
    const secondShutdown = telemetry.shutdown();

    expect(firstShutdown).toBe(secondShutdown);
    await expect(firstShutdown).rejects.toBe(shutdownFailure);
    expect(harness.shutdown).toHaveBeenCalledOnce();
  });

  it('caches an asynchronously rejected SDK shutdown', async () => {
    const harness = sdkHarness();
    const shutdownFailure = new Error('asynchronous shutdown failed');
    harness.shutdown.mockRejectedValueOnce(shutdownFailure);
    const telemetry = createTelemetryLifecycle(
      enabledConfig(),
      harness.factory,
    );
    telemetry.start();

    const firstShutdown = telemetry.shutdown();
    const secondShutdown = telemetry.shutdown();

    expect(firstShutdown).toBe(secondShutdown);
    await expect(firstShutdown).rejects.toBe(shutdownFailure);
    expect(harness.shutdown).toHaveBeenCalledOnce();
  });
});
