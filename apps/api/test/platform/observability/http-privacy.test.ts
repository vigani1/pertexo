import type * as NestCommon from '@nestjs/common';
import type * as NestCore from '@nestjs/core';
import type * as NestFastify from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import type * as Http from 'node:http';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  createOpenTelemetrySdk,
  parseObservabilityConfig,
} from '@pertexo/observability/startup';
import { registerApiMetrics } from '../../../src/platform/observability/api-metrics.js';

const attributesSchema = z.array(
  z.object({
    key: z.string(),
    value: z.object({
      stringValue: z.string().optional(),
      intValue: z.union([z.string(), z.number()]).optional(),
    }),
  }),
);
const exportSchema = z.object({
  resourceSpans: z.array(
    z.object({
      resource: z.object({ attributes: attributesSchema }),
      scopeSpans: z.array(
        z.object({
          spans: z.array(
            z
              .object({
                name: z.string(),
                kind: z.number(),
                traceId: z.string(),
                spanId: z.string(),
                attributes: attributesSchema,
              })
              .loose(),
          ),
        }),
      ),
    }),
  ),
});
const attributes = (input: z.output<typeof attributesSchema>) =>
  Object.fromEntries(
    input.map(({ key, value }) => [
      key,
      value.stringValue ?? Number(value.intValue),
    ]),
  );

it('exports matched API templates and host-only clients without sensitive request or error text', async () => {
  const require = createRequire(import.meta.url);
  const http = require('node:http') as typeof Http;
  const exports: unknown[] = [];
  const metricExports: unknown[] = [];
  const collector = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/v1/metrics')
        metricExports.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        );
      if (request.url === '/v1/traces')
        exports.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        );
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    });
  });
  collector.listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const collectorAddress = collector.address();
  if (collectorAddress === null || typeof collectorAddress === 'string')
    throw new Error('Collector not listening');
  const sdk = createOpenTelemetrySdk({
    ...parseObservabilityConfig({
      environment: 'test',
      serviceName: 'api',
      serviceVersion: 'privacy-proof',
      logLevel: 'trace',
    }),
    otlpHttpEndpoint: `http://127.0.0.1:${String(collectorAddress.port)}`,
  });
  const logs: Record<string, unknown>[] = [];
  let app: NestCommon.INestApplication | undefined;
  const sentinels = [
    'path-credential',
    'person@example.test',
    'person%40example.test',
    'query-credential',
    'userinfo-name',
    'userinfo-password',
    'unlabelled-private-text',
    'private-error-name-person@example.test',
    'private-error-code-person@example.test',
  ];
  try {
    sdk.start();
    require('reflect-metadata');
    const { Controller, Get, Module } =
      require('@nestjs/common') as typeof NestCommon;
    const { NestFactory } = require('@nestjs/core') as typeof NestCore;
    const { FastifyAdapter } =
      require('@nestjs/platform-fastify') as typeof NestFastify;
    const { createStructuredLogger } =
      await import('@pertexo/observability/server');
    const logger = createStructuredLogger(
      parseObservabilityConfig({
        environment: 'test',
        serviceName: 'api',
        serviceVersion: 'privacy-proof',
        logLevel: 'trace',
      }),
      {
        write: (message) => {
          logs.push(JSON.parse(message) as Record<string, unknown>);
        },
      },
    );
    class PrivacyController {
      read() {
        logger.error(
          'http.operation_failed',
          {
            method: 'GET',
            status: 503,
            host: 'local-service',
            operation: 'privacy.read',
          },
          new Error(
            'unlabelled-private-text person@example.test /reset/path-credential?code=query-credential',
            {
              cause: new Error(
                'http://userinfo-name:userinfo-password@service.test/private/path-credential',
              ),
            },
          ),
        );
        return { ok: true };
      }
      fail() {
        throw new Error(
          'unlabelled-private-text /private/path-credential person@example.test',
        );
      }
    }
    Controller('v1/privacy')(PrivacyController);
    const descriptor = Object.getOwnPropertyDescriptor(
      PrivacyController.prototype,
      'read',
    );
    if (descriptor === undefined) throw new Error('Missing controller handler');
    Get(':subject')(PrivacyController.prototype, 'read', descriptor);
    const failDescriptor = Object.getOwnPropertyDescriptor(
      PrivacyController.prototype,
      'fail',
    );
    if (failDescriptor === undefined)
      throw new Error('Missing failure handler');
    Get(':subject/fail')(PrivacyController.prototype, 'fail', failDescriptor);
    // Nest module registration requires a class container.
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    class PrivacyModule {}
    Module({ controllers: [PrivacyController] })(PrivacyModule);
    app = await NestFactory.create(PrivacyModule, new FastifyAdapter(), {
      logger: false,
    });
    registerApiMetrics(app.getHttpAdapter().getInstance() as FastifyInstance);
    const { ProblemDetailsFilter } =
      await import('../../../src/platform/http/problem-details.filter.js');
    const { RequestContextStore } =
      await import('../../../src/platform/http/request-context.js');
    app.useGlobalFilters(
      new ProblemDetailsFilter(new RequestContextStore(), {
        log: (entry) => {
          logger.warn('http.request_failed', entry, entry.cause);
        },
      }),
    );
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as Http.Server;
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('API not listening');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const send = (path: string) =>
      new Promise<void>((resolve, reject) => {
        const request = http.get(
          origin.replace('://', '://userinfo-name:userinfo-password@') + path,
          (response) => {
            response.resume();
            response.once('end', resolve);
          },
        );
        request.once('error', reject);
      });
    await send('/v1/privacy/person%40example.test?code=query-credential');
    await send('/v1/privacy/person%40example.test/fail?code=query-credential');
    await send(
      '/bot-path-credential/person@example.test?arbitrary=query-credential',
    );
    await (
      await fetch(origin + '/v1/privacy/path-credential?code=query-credential')
    ).arrayBuffer();
    await (
      await fetch(origin + '/encoded/%70ath-credential/person%40example.test')
    ).arrayBuffer();
    await expect(
      new Promise<void>((resolve, reject) => {
        const request = http.get(
          `http://lookup.example.test:${String(address.port)}/path-credential`,
          {
            lookup: (_host, _options, callback) => {
              callback(
                Object.assign(new Error('unlabelled-private-text'), {
                  name: 'private-error-name-person@example.test',
                  code: 'private-error-code-person@example.test',
                }),
                '',
                4,
              );
            },
          },
          (response) => {
            response.resume();
            response.once('end', resolve);
          },
        );
        request.once('error', reject);
      }),
    ).rejects.toBeDefined();
    await app.close();
    app = undefined;
    await sdk.shutdown();
    const spans = exports.flatMap((payload) =>
      exportSchema.parse(payload).resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) =>
          scope.spans.map((span) => ({
            ...span,
            attributes: attributes(span.attributes),
            resource: attributes(resource.resource.attributes),
          })),
        ),
      ),
    );
    expect(spans.length).toBeGreaterThanOrEqual(8);
    const serialized = JSON.stringify({ spans, logs, metricExports });
    for (const secret of sentinels) expect(serialized).not.toContain(secret);
    const servers = spans.filter(
      (span) =>
        span.kind === 2 && span.attributes['server.port'] === address.port,
    );
    expect(servers).toHaveLength(5);
    expect(
      servers.filter(
        (span) => span.attributes['http.route'] === '/v1/privacy/:subject',
      ),
    ).toHaveLength(2);
    expect(
      servers.filter((span) => span.attributes['url.path'] === 'unmatched'),
    ).toHaveLength(2);
    expect(
      servers.find(
        (span) => span.attributes['http.response.status_code'] === 500,
      )?.attributes,
    ).toMatchObject({
      'http.route': '/v1/privacy/:subject/fail',
      'url.path': '/v1/privacy/:subject/fail',
    });
    for (const span of servers) {
      expect(span.attributes['http.request.method']).toBe('GET');
      expect([200, 404, 500]).toContain(
        span.attributes['http.response.status_code'],
      );
      expect(span.resource).toMatchObject({
        'service.name': 'api',
        'service.version': 'privacy-proof',
      });
    }
    const clients = spans.filter(
      (span) =>
        span.kind === 3 &&
        span.attributes['server.port'] === address.port &&
        span.attributes['server.address'] === '127.0.0.1',
    );
    expect(clients).toHaveLength(5);
    for (const span of clients) {
      expect(span.attributes).toMatchObject({
        'url.full': origin,
        'server.address': '127.0.0.1',
        'http.request.method': 'GET',
      });
      expect(span.attributes).not.toHaveProperty('url.path');
      expect([200, 404, 500]).toContain(
        span.attributes['http.response.status_code'],
      );
    }
    expect(
      spans
        .filter((span) => span.attributes['nestjs.type'] === 'request_context')
        .map((span) => span.attributes['url.full']),
    ).toEqual([
      '/v1/privacy/:subject',
      '/v1/privacy/:subject/fail',
      '/v1/privacy/:subject',
    ]);
    expect(metricExports.length).toBeGreaterThan(0);
    const serializedMetrics = JSON.stringify(metricExports);
    for (const dimension of [
      'http.client.request.duration',
      'http.request.method',
      'http.response.status_code',
      'server.address',
      '127.0.0.1',
    ])
      expect(serializedMetrics).toContain(dimension);
    expect(serializedMetrics).not.toContain('error.type');
    const refused = spans.find(
      (span) =>
        span.kind === 3 &&
        span.attributes['server.address'] === 'lookup.example.test',
    );
    expect(refused).toMatchObject({
      status: { code: 2 },
      attributes: {
        'http.request.method': 'GET',
        'url.full': `http://lookup.example.test:${String(address.port)}`,
      },
    });
    const operations = logs.filter(
      (log) => log.event === 'http.operation_failed',
    );
    const requests = logs.filter((log) => log.event === 'http.request_failed');
    expect(requests).toHaveLength(3);
    expect(requests.filter((log) => log.route === 'unmatched')).toHaveLength(2);
    expect(
      requests.filter((log) => log.route === '/v1/privacy/:subject/fail'),
    ).toHaveLength(1);
    expect(operations).toHaveLength(2);
    for (const log of requests) {
      expect(log.serviceName).toBe('api');
      expect(
        spans.some(
          (span) => span.traceId === log.traceId && span.spanId === log.spanId,
        ),
      ).toBe(true);
    }
    for (const log of operations) {
      expect(log).toMatchObject({
        event: 'http.operation_failed',
        method: 'GET',
        status: 503,
        host: 'local-service',
        operation: 'privacy.read',
        serviceName: 'api',
      });
      expect(
        spans.some(
          (span) => span.traceId === log.traceId && span.spanId === log.spanId,
        ),
      ).toBe(true);
    }
  } finally {
    await app?.close();
    await sdk.shutdown();
    collector.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      collector.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }),
    );
  }
}, 30_000);
