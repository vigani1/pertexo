import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  defaultResource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

import './server-only.js';

import type { ObservabilityConfig } from './config.js';

export interface TelemetryLifecycle {
  readonly enabled: boolean;
  readonly started: boolean;
  shutdown(): Promise<void>;
  start(): void;
}

export interface TelemetrySdk {
  shutdown(): Promise<void>;
  start(): void;
}

export type TelemetrySdkFactory = (
  config: ObservabilityConfig & { readonly otlpHttpEndpoint: string },
) => TelemetrySdk;

function signalEndpoint(baseEndpoint: string, signalPath: string): string {
  const base = new URL(baseEndpoint);
  base.pathname = `${base.pathname.replace(/\/$/u, '')}/${signalPath}`;
  return base.toString();
}

export function createOpenTelemetrySdk(
  config: ObservabilityConfig & { readonly otlpHttpEndpoint: string },
): TelemetrySdk {
  const headers = { ...config.otlpHeaders };
  const resource = defaultResource().merge(
    resourceFromAttributes({
      'deployment.environment.name': config.environment,
      'service.name': config.serviceName,
      'service.version': config.serviceVersion,
    }),
  );

  return new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations()],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          headers,
          url: signalEndpoint(config.otlpHttpEndpoint, 'v1/metrics'),
        }),
        exportIntervalMillis: 60_000,
        exportTimeoutMillis: 30_000,
      }),
    ],
    resource,
    traceExporter: new OTLPTraceExporter({
      headers,
      url: signalEndpoint(config.otlpHttpEndpoint, 'v1/traces'),
    }),
  });
}

class DisabledTelemetryLifecycle implements TelemetryLifecycle {
  public readonly enabled = false;
  public readonly started = false;

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public start(): void {
    return undefined;
  }
}

class EnabledTelemetryLifecycle implements TelemetryLifecycle {
  public readonly enabled = true;
  private state: 'created' | 'started' | 'stopped' = 'created';
  private shutdownResult: Promise<void> | undefined;

  public constructor(private readonly sdk: TelemetrySdk) {}

  public get started(): boolean {
    return this.state === 'started';
  }

  public start(): void {
    if (this.state === 'started') {
      return;
    }

    if (this.state === 'stopped') {
      throw new Error('Telemetry cannot be restarted after shutdown');
    }

    this.sdk.start();
    this.state = 'started';
  }

  public shutdown(): Promise<void> {
    if (this.shutdownResult !== undefined) {
      return this.shutdownResult;
    }

    if (this.state === 'created') {
      this.state = 'stopped';
      this.shutdownResult = Promise.resolve();
      return this.shutdownResult;
    }

    this.state = 'stopped';
    this.shutdownResult = this.sdk.shutdown();
    return this.shutdownResult;
  }
}

export function createTelemetryLifecycle(
  config: ObservabilityConfig,
  sdkFactory: TelemetrySdkFactory = createOpenTelemetrySdk,
): TelemetryLifecycle {
  if (config.otlpHttpEndpoint === undefined) {
    return new DisabledTelemetryLifecycle();
  }

  return new EnabledTelemetryLifecycle(
    sdkFactory({ ...config, otlpHttpEndpoint: config.otlpHttpEndpoint }),
  );
}
