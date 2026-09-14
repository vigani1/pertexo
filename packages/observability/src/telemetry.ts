import { randomUUID } from 'node:crypto';

import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { Tracer, TracerProvider } from '@opentelemetry/api';
import { HostMetricsInstrumentation } from '@opentelemetry/instrumentation-host-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import {
  defaultResource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

import './server-only.js';

import type { ObservabilityConfig } from './config.js';
import {
  installErrorSanitizer,
  sanitizeHttpSpan,
  sanitizeIncomingHttpRequest,
  sanitizeOutgoingHttpRequest,
  sanitizeUndiciRequest,
} from './telemetry-sanitization.js';

export const METRIC_EXPORT_INTERVAL_MILLISECONDS = 60_000;
export const METRIC_EXPORT_TIMEOUT_MILLISECONDS = 30_000;

function errorSanitizingTracerProvider(
  provider: TracerProvider,
): TracerProvider {
  return {
    getTracer(name, version, options): Tracer {
      const tracer = provider.getTracer(name, version, options);
      return {
        startActiveSpan: tracer.startActiveSpan.bind(tracer),
        startSpan(spanName, spanOptions, spanContext) {
          const span = tracer.startSpan(spanName, spanOptions, spanContext);
          installErrorSanitizer(span);
          return span;
        },
      };
    },
  };
}

class ErrorSanitizingNestInstrumentation extends NestInstrumentation {
  public override setTracerProvider(provider: TracerProvider): void {
    super.setTracerProvider(errorSanitizingTracerProvider(provider));
  }
}

class ErrorSanitizingPgInstrumentation extends PgInstrumentation {
  public override setTracerProvider(provider: TracerProvider): void {
    super.setTracerProvider(errorSanitizingTracerProvider(provider));
  }
}

export interface TelemetryLifecycle {
  readonly enabled: boolean;
  readonly started: boolean;
  flush?(): Promise<void>;
  shutdown(): Promise<void>;
  start(): void;
}

export interface TelemetrySdk {
  forceFlush?(): Promise<void>;
  shutdown(): Promise<void>;
  start(): void;
}

export type TelemetrySdkFactory = (
  config: ObservabilityConfig & { readonly otlpHttpEndpoint: string },
) => TelemetrySdk;

export function createNodeInstrumentations() {
  return [
    new HttpInstrumentation({
      requestHook: sanitizeHttpSpan,
      startIncomingSpanHook: sanitizeIncomingHttpRequest,
      startOutgoingSpanHook: sanitizeOutgoingHttpRequest,
    }),
    new UndiciInstrumentation({
      requestHook: sanitizeHttpSpan,
      startSpanHook: sanitizeUndiciRequest,
    }),
    new ErrorSanitizingNestInstrumentation(),
    new PinoInstrumentation(),
    new ErrorSanitizingPgInstrumentation(),
    new HostMetricsInstrumentation({
      metricGroups: ['process.cpu', 'process.memory'],
    }),
    new RuntimeNodeInstrumentation({ monitoringPrecision: 10 }),
  ];
}

function signalEndpoint(baseEndpoint: string, signalPath: string): string {
  const base = new URL(baseEndpoint);
  base.pathname = `${base.pathname.replace(/\/$/u, '')}/${signalPath}`;
  return base.toString();
}

export function createTelemetryResource(
  config: ObservabilityConfig,
  serviceInstanceId: string,
) {
  return defaultResource().merge(
    resourceFromAttributes({
      'deployment.environment.name': config.environment,
      'service.instance.id': serviceInstanceId,
      'service.name': config.serviceName,
      'service.version': config.serviceVersion,
    }),
  );
}

export function createOpenTelemetrySdk(
  config: ObservabilityConfig & { readonly otlpHttpEndpoint: string },
): TelemetrySdk {
  const headers = { ...config.otlpHeaders };
  const resource = createTelemetryResource(config, randomUUID());
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      headers,
      url: signalEndpoint(config.otlpHttpEndpoint, 'v1/metrics'),
    }),
    exportIntervalMillis: METRIC_EXPORT_INTERVAL_MILLISECONDS,
    exportTimeoutMillis: METRIC_EXPORT_TIMEOUT_MILLISECONDS,
  });
  const sdk = new NodeSDK({
    instrumentations: createNodeInstrumentations(),
    metricReaders: [metricReader],
    resource,
    traceExporter: new OTLPTraceExporter({
      headers,
      url: signalEndpoint(config.otlpHttpEndpoint, 'v1/traces'),
    }),
  });

  return {
    forceFlush: () => metricReader.forceFlush(),
    shutdown: () => sdk.shutdown(),
    start: () => {
      sdk.start();
    },
  };
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
  private state: 'created' | 'start_failed' | 'started' | 'stopped' = 'created';
  private startFailure: unknown;
  private shutdownResult: Promise<void> | undefined;

  public constructor(private readonly sdk: TelemetrySdk) {}

  public get started(): boolean {
    return this.state === 'started';
  }

  public flush(): Promise<void> {
    if (this.state !== 'started') {
      throw new Error('Telemetry can only flush while started');
    }
    return this.sdk.forceFlush?.() ?? Promise.resolve();
  }

  public start(): void {
    if (this.state === 'started') {
      return;
    }

    if (this.state === 'stopped') {
      throw new Error('Telemetry cannot be restarted after shutdown');
    }

    if (this.state === 'start_failed') {
      throw this.startFailure;
    }

    try {
      this.sdk.start();
      this.state = 'started';
    } catch (error: unknown) {
      this.startFailure = error;
      this.state = 'start_failed';
      throw error;
    }
  }

  public shutdown(): Promise<void> {
    if (this.shutdownResult !== undefined) {
      return this.shutdownResult;
    }

    const state = this.state;
    if (state === 'created') {
      this.state = 'stopped';
      this.shutdownResult = Promise.resolve();
      return this.shutdownResult;
    }

    this.state = 'stopped';
    let resolveShutdown!: () => void;
    let rejectShutdown!: (reason: unknown) => void;
    this.shutdownResult = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    try {
      this.sdk.shutdown().then(resolveShutdown, rejectShutdown);
    } catch (error: unknown) {
      rejectShutdown(error);
    }
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
