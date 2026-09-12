import { metrics, SpanStatusCode } from '@opentelemetry/api';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { node } from '@opentelemetry/sdk-node';
import { describe, expect, it } from 'vitest';

import { createNodeInstrumentations } from '../src/telemetry.js';

type FinishedSpan = ReturnType<
  node.InMemorySpanExporter['getFinishedSpans']
>[number];

function traceHarness() {
  const exporter = new node.InMemorySpanExporter();
  const provider = new node.NodeTracerProvider({
    spanProcessors: [new node.SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider };
}

function serialized(spans: readonly FinishedSpan[]): string {
  return JSON.stringify(
    spans.map((span) => ({
      attributes: span.attributes,
      events: span.events,
      name: span.name,
      status: span.status,
    })),
  );
}

describe('non-HTTP telemetry error privacy', () => {
  it('sanitizes errors exported by the configured Nest instrumentation', async () => {
    const { exporter, provider } = traceHarness();
    const instrumentation = createNodeInstrumentations().find(
      (candidate) => candidate instanceof NestInstrumentation,
    );
    if (!(instrumentation instanceof NestInstrumentation)) {
      throw new Error('Expected configured Nest instrumentation');
    }
    instrumentation.setTracerProvider(provider);

    const metadataReflect = Reflect as typeof Reflect & {
      defineMetadata?: (...arguments_: unknown[]) => boolean;
      getMetadataKeys?: (...arguments_: unknown[]) => unknown[];
    };
    const getMetadataKeys = metadataReflect.getMetadataKeys;
    const defineMetadata = metadataReflect.defineMetadata;
    metadataReflect.getMetadataKeys = () => [];
    metadataReflect.defineMetadata = () => true;

    class RouterExecutionContext {
      public create(
        _instance: object,
        callback: (...arguments_: unknown[]) => unknown,
      ) {
        return (...arguments_: unknown[]) => callback(...arguments_);
      }
    }

    const module = { RouterExecutionContext };
    const definition =
      instrumentation.getRouterExecutionContextFileInstrumentation(['>=4 <12']);
    definition.patch(module, '11.2.1');
    const statusSecret = 'SYNTHETIC_SECRET_123';
    const typeSecret = 'SyntheticSecretType';
    const failure = new Error(statusSecret);
    failure.name = typeSecret;

    try {
      const handler = new RouterExecutionContext().create(
        { constructor: { name: 'FailureController' } },
        function failRequest() {
          return Promise.reject(failure);
        },
      );
      await expect(
        handler(
          { method: 'GET', route: { path: '/failure' }, url: '/failure' },
          {},
          () => undefined,
        ),
      ).rejects.toBe(failure);

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      expect(
        spans.flatMap((span) =>
          span.events.map((event) => event.attributes?.['exception.type']),
        ),
      ).toEqual(['Error', 'Error']);
      expect(serialized(spans)).not.toContain(typeSecret);
      expect(
        spans.every((span) => span.status.code === SpanStatusCode.ERROR),
      ).toBe(true);
      expect(spans.every((span) => span.status.message === undefined)).toBe(
        true,
      );
      expect(serialized(spans)).not.toContain(statusSecret);
    } finally {
      definition.unpatch(module, '11.2.1');
      if (getMetadataKeys === undefined) {
        delete metadataReflect.getMetadataKeys;
      } else {
        metadataReflect.getMetadataKeys = getMetadataKeys;
      }
      if (defineMetadata === undefined) {
        delete metadataReflect.defineMetadata;
      } else {
        metadataReflect.defineMetadata = defineMetadata;
      }
      instrumentation.disable();
      await provider.shutdown();
    }
  });

  it('sanitizes errors exported by the configured PG instrumentation', async () => {
    const { exporter, provider } = traceHarness();
    const instrumentation = createNodeInstrumentations().find(
      (candidate) => candidate instanceof PgInstrumentation,
    );
    if (!(instrumentation instanceof PgInstrumentation)) {
      throw new Error('Expected configured PG instrumentation');
    }
    instrumentation.setTracerProvider(provider);
    instrumentation.setMeterProvider(metrics.getMeterProvider());

    const statusSecret = 'SYNTHETIC_SECRET_123';
    const typeSecret = 'SyntheticSecretType';
    const failure = new Error(statusSecret);
    failure.name = typeSecret;
    class Client {
      public readonly connectionParameters = {
        database: 'pertexo_test',
        host: '127.0.0.1',
        port: 5432,
        user: 'runtime',
      };
      public readonly database = 'pertexo_test';

      public connect(): Promise<void> {
        return Promise.resolve();
      }

      public query(): Promise<never> {
        return Promise.reject(failure);
      }
    }

    const module = { Client };
    const definition = instrumentation
      .getModuleDefinitions()
      .find((candidate) => candidate.name === 'pg');
    if (definition === undefined) {
      throw new Error('Expected PG module definition');
    }
    if (definition.patch === undefined) {
      throw new Error('Expected PG module patch');
    }
    definition.patch(module, '8.23.0');

    try {
      await expect(new Client().query()).rejects.toBe(failure);
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(serialized(spans)).not.toContain(typeSecret);
      expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(spans[0]?.events[0]?.attributes).toEqual({
        'exception.message': '[Redacted exception]',
      });
      expect(serialized(spans)).not.toContain(statusSecret);
    } finally {
      definition.unpatch?.(module, '8.23.0');
      instrumentation.disable();
      await provider.shutdown();
    }
  });
});
