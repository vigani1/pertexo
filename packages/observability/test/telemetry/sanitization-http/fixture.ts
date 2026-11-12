import type * as httpTypes from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { SpanKind } from '@opentelemetry/api';

import {
  InMemorySpanExporter,
  TracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace';
import { expect } from 'vitest';
import { createNodeInstrumentations } from '../../../src/telemetry/telemetry.runtime.js';

export const WEBHOOK_PATH_SECRET = 'k'.repeat(43);

export const WEBHOOK_HEADER_SECRET = 'opaque-webhook-header-credential';

export const QUERY_SECRET = 'oauth-code-secret';

export const STATE_SECRET = 'oauth-state-secret';

export const ARBITRARY_SECRET = 'arbitrary-query-secret';

export const ERROR_QUERY_SECRET = 'error-query-secret';

export const HOOK_ERROR_QUERY_SECRET = 'hook-error-query-secret';

export const FRAGMENT_SECRET = 'fragment-secret';

export const MALFORMED_CREDENTIAL_SECRET = 'malformed-credential-secret';

export const ERROR_NAME_SECRET = 'private-name-person@example.test';

export const ERROR_CODE_SECRET = 'error-code-secret';

export const MULTI_USERINFO_SECRET = 'opaque-userinfo-secret';

export const SPACED_QUERY_SECRET = 'spaced-query-secret';

type HttpModule = typeof httpTypes;

type HttpServer = httpTypes.Server;

type HttpClientRequest = httpTypes.ClientRequest;

type Settled<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ error: unknown; ok: false }>;

async function settle<T>(operation: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { error, ok: false };
  }
}

async function listen(server: HttpServer): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to have a TCP address');
  }

  return address.port;
}

async function close(server: HttpServer): Promise<void> {
  if (!server.listening) {
    return;
  }

  server.close();
  await once(server, 'close');
}

function request(
  http: HttpModule,
  url: string,
  options?: httpTypes.RequestOptions,
): Promise<{ readonly statusCode: number | undefined }> {
  return new Promise((resolve, reject) => {
    let clientRequest: HttpClientRequest;
    const responseHandler = (response: httpTypes.IncomingMessage) => {
      response.resume();
      response.once('end', () => {
        resolve({ statusCode: response.statusCode });
      });
    };

    try {
      clientRequest =
        options === undefined
          ? http.get(url, responseHandler)
          : http.get(url, options, responseHandler);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    clientRequest.once('error', reject);
  });
}

async function captureConfiguredHttpExport() {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const instrumentations = createNodeInstrumentations();
  const httpInstrumentation = instrumentations.find(
    (instrumentation) =>
      instrumentation.instrumentationName ===
      '@opentelemetry/instrumentation-http',
  );
  const undiciInstrumentation = instrumentations.find(
    (instrumentation) =>
      instrumentation.instrumentationName ===
      '@opentelemetry/instrumentation-undici',
  );

  if (
    httpInstrumentation === undefined ||
    undiciInstrumentation === undefined
  ) {
    throw new Error('Expected HTTP and Undici instrumentation');
  }

  const require = createRequire(import.meta.url);
  const http = require('http') as HttpModule;
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/undici-client')) {
      response.statusCode = 503;
    }
    response.end('ok');
  });
  let closedServer: HttpServer | undefined;

  const capture = await settle(async () => {
    httpInstrumentation.setTracerProvider(provider);
    undiciInstrumentation.setTracerProvider(provider);
    httpInstrumentation.enable();
    undiciInstrumentation.enable();

    const port = await listen(server);
    const portText = String(port);
    const origin = `http://127.0.0.1:${portText}`;

    const firstSpan = exporter.getFinishedSpans().length;
    await request(
      http,
      `http://user:password@127.0.0.1:${portText}/http-client?code=${QUERY_SECRET}&state=${STATE_SECRET}&arbitrary=${ARBITRARY_SECRET}`,
    );
    const firstSpans = exporter.getFinishedSpans().slice(firstSpan);
    const serverSpans = firstSpans.filter(
      (span) => span.kind === SpanKind.SERVER,
    );
    const httpClientSpans = firstSpans.filter(
      (span) => span.kind === SpanKind.CLIENT,
    );
    const undiciStart = exporter.getFinishedSpans().length;
    const fetchResponse = await fetch(
      `${origin}/undici-client?code=${QUERY_SECRET}&state=${STATE_SECRET}&arbitrary=${ARBITRARY_SECRET}`,
    );
    await fetchResponse.arrayBuffer();
    const undiciClientSpans = exporter
      .getFinishedSpans()
      .slice(undiciStart)
      .filter((span) => span.kind === SpanKind.CLIENT);
    const webhookStart = exporter.getFinishedSpans().length;
    const webhookUrl = `${origin}/hooks/${WEBHOOK_PATH_SECRET}`;
    await request(http, webhookUrl, {
      headers: { 'x-webhook-secret': WEBHOOK_HEADER_SECRET },
    });
    await (
      await fetch(webhookUrl, {
        headers: { authorization: `Bearer ${WEBHOOK_HEADER_SECRET}` },
      })
    ).arrayBuffer();

    const webhookSpans = exporter.getFinishedSpans().slice(webhookStart);
    closedServer = http.createServer();
    const closedPort = await listen(closedServer);
    await close(closedServer);
    const closedPortText = String(closedPort);
    const closedOrigin = `http://127.0.0.1:${closedPortText}`;

    const httpErrorStart = exporter.getFinishedSpans().length;
    await expect(
      request(
        http,
        `http://user:password@127.0.0.1:${closedPortText}/http-error?code=${ERROR_QUERY_SECRET}&state=${STATE_SECRET}&arbitrary=${ARBITRARY_SECRET}`,
      ),
    ).rejects.toBeDefined();
    const httpErrorSpans = exporter
      .getFinishedSpans()
      .slice(httpErrorStart)
      .filter((span) => span.kind === SpanKind.CLIENT);
    const hookErrorStart = exporter.getFinishedSpans().length;
    await expect(
      request(
        http,
        `http://user:password@example.test:${portText}/http-error-hook?code=${HOOK_ERROR_QUERY_SECRET}&state=${STATE_SECRET}&arbitrary=${ARBITRARY_SECRET}`,
        {
          lookup: (_hostname, _options, callback) => {
            const error = Object.assign(
              new Error(
                `lookup failed for http://user:password@${MULTI_USERINFO_SECRET}@example.test:${portText}/http-error-hook?code=${HOOK_ERROR_QUERY_SECRET} trailing=${SPACED_QUERY_SECRET}#${FRAGMENT_SECRET}`,
              ),
              {
                name: ERROR_NAME_SECRET,
                code: `http://user:password@${MULTI_USERINFO_SECRET}@example.test:${portText}/error?code=${ERROR_CODE_SECRET} trailing=${SPACED_QUERY_SECRET}#${FRAGMENT_SECRET}`,
              },
            );
            callback(error, '', 4);
          },
        },
      ),
    ).rejects.toBeDefined();
    const hookErrorSpans = exporter
      .getFinishedSpans()
      .slice(hookErrorStart)
      .filter((span) => span.kind === SpanKind.CLIENT);
    const undiciErrorStart = exporter.getFinishedSpans().length;
    await expect(
      fetch(
        `${closedOrigin}/undici-error?code=${ERROR_QUERY_SECRET}&state=${STATE_SECRET}&arbitrary=${ARBITRARY_SECRET}`,
      ),
    ).rejects.toBeDefined();
    const undiciErrorSpans = exporter
      .getFinishedSpans()
      .slice(undiciErrorStart)
      .filter((span) => span.kind === SpanKind.CLIENT);
    const malformedStart = exporter.getFinishedSpans().length;
    await expect(
      request(
        http,
        `http://user:password@[bad-host#${MALFORMED_CREDENTIAL_SECRET}`,
      ),
    ).rejects.toBeDefined();

    const spans = exporter.getFinishedSpans();
    const malformedSpans = spans
      .slice(malformedStart)
      .filter((span) => span.kind === SpanKind.CLIENT);

    return Object.freeze({
      closedOrigin,
      hookErrorSpans,
      httpClientSpans,
      httpErrorSpans,
      malformedSpans,
      origin,
      portText,
      serverSpans,
      spans,
      undiciClientSpans,
      undiciErrorSpans,
      webhookSpans,
    });
  });
  const cleanupResults = await Promise.allSettled([
    close(server),
    closedServer === undefined ? Promise.resolve() : close(closedServer),
    Promise.resolve().then(() => {
      httpInstrumentation.disable();
    }),
    Promise.resolve().then(() => {
      undiciInstrumentation.disable();
    }),
    provider.shutdown(),
  ]);
  const cleanupFailures = cleanupResults
    .filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    .map(({ reason }): unknown => reason as unknown);
  if (!capture.ok) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [capture.error, ...cleanupFailures],
        'HTTP telemetry capture and cleanup failed',
      );
    }
    throw capture.error;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      'HTTP telemetry test cleanup failed',
    );
  }
  return capture.value;
}

export let captured!: Awaited<ReturnType<typeof captureConfiguredHttpExport>>;

export async function prepareConfiguredHTTPUndiciExportScenariosFixture() {
  captured = await captureConfiguredHttpExport();
}
