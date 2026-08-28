import { describe, expect, it, vi } from 'vitest';

import { parseObservabilityConfig } from '../src/config.js';
import {
  createNodeAutoInstrumentations,
  createTelemetryLifecycle,
  type NodeAutoInstrumentationsFactory,
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
  sdk: TelemetrySdk;
  shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>;
  start: ReturnType<typeof vi.fn<() => void>>;
} {
  const start = vi.fn<() => void>();
  const shutdown = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const sdk = { shutdown, start };
  const factory = vi.fn<TelemetrySdkFactory>(() => sdk);
  return { factory, sdk, shutdown, start };
}

describe('createNodeAutoInstrumentations', () => {
  it('enables only process host metrics and configures runtime monitoring', () => {
    const factory = vi.fn<NodeAutoInstrumentationsFactory>(() => []);

    const instrumentations = createNodeAutoInstrumentations(factory);

    expect(instrumentations).toEqual([]);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({
      '@opentelemetry/instrumentation-host-metrics': {
        enabled: true,
        metricGroups: ['process.cpu', 'process.memory'],
      },
      '@opentelemetry/instrumentation-runtime-node': {
        enabled: true,
        monitoringPrecision: 10,
      },
    });
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
});
