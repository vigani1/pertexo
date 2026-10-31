import { httpConnections } from './http-execution.js';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, vi } from 'vitest';
import { createNodeCatalog } from '@pertexo/node-sdk';
import {
  createNodeRegistry,
  type NodeExecutionRuntime,
  type NodeArtifactRuntime,
} from '@pertexo/node-sdk/server';
import {
  HTTP_REQUEST_MANIFEST,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
} from '../../src/index.js';
import {
  createHttpRequestExecutorRegistration,
  createNodeSecureHttpClient,
  parseAllowedPrivateNetworks,
} from '../../src/server.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(closers.splice(0).map((close) => close()));
});
export async function server(
  handler: (
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ) => void,
) {
  const app = createServer((request, response) => {
    handler(new URL(request.url ?? '/', 'http://localhost'), request, response);
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing test address');
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        app.closeAllConnections();
        app.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  );
  return `http://127.0.0.1:${String(address.port)}`;
}
export function json(response: ServerResponse, value: unknown) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}
export function setup(
  url: string,
  pagination: Record<string, unknown>,
  options: Readonly<{
    signal?: AbortSignal;
    deadlineAt?: Date;
    credentials?: boolean;
    singleRequest?: boolean;
    unexpectedTransportFailure?: boolean;
    config?: Record<string, unknown>;
    artifacts?: NodeArtifactRuntime;
  }> = {},
) {
  const connectionId = randomUUID();
  const secret = new TextEncoder().encode(
    JSON.stringify({
      type: 'http_headers',
      headers: { authorization: 'Bearer test-page-secret' },
    }),
  );
  const beforeDispatch = vi.fn<NodeExecutionRuntime['beforeDispatch']>(() =>
    Promise.resolve(),
  );
  const assertCurrent = vi.fn(() => Promise.resolve());
  const write = vi.fn(() =>
    Promise.reject(new Error('Paging must never write an artifact')),
  );
  const runtime: NodeExecutionRuntime = {
    workspaceId: randomUUID(),
    runId: randomUUID(),
    nodeRunId: randomUUID(),
    attemptId: randomUUID(),
    nodeId: 'http',
    invocationKey: 'http',
    attemptNumber: 1,
    sideEffectClass: 'unsafe',
    beforeDispatch,
    artifacts: options.artifacts ?? { write },
    ...(options.deadlineAt === undefined
      ? {}
      : { deadlineAt: options.deadlineAt }),
    ...(options.credentials === true
      ? {
          connections: httpConnections({
            assertCurrent,
            resolve: () =>
              Promise.resolve({
                connectionId,
                providerKey: 'http',
                authType: 'http_headers',
                secretVersionId: randomUUID(),
                secret,
              }),
          }),
        }
      : {}),
  };
  const config = {
    method: 'GET',
    url,
    headers: {},
    timeoutMillis: 1000,
    maxRedirects: 3,
    maxResponseBytes: 1_048_576,
    inlineResponseBytes: 262_144,
    pagination: {
      itemsPath: '$.data',
      maxPages: 10,
      delayMillis: 0,
      ...pagination,
    },
    ...options.config,
  };
  if (options.singleRequest === true)
    Reflect.deleteProperty(config, 'pagination');
  const registry = createNodeRegistry({
    catalog: createNodeCatalog({
      definitions: [HTTP_REQUEST_MANIFEST],
      executors: [
        {
          executor: HTTP_REQUEST_MANIFEST.executor,
          abiVersion: 2,
          definitions: [HTTP_REQUEST_MANIFEST.definition],
          policyReferences: HTTP_REQUEST_MANIFEST.policyReferences,
        },
      ],
      policies: HTTP_REQUEST_MANIFEST.policyReferences,
    }),
    definitions: [HTTP_REQUEST_DEFINITION_REGISTRATION],
    executors: [
      createHttpRequestExecutorRegistration({
        httpClient:
          options.unexpectedTransportFailure === true
            ? {
                executeStreaming: () =>
                  Promise.reject(new Error('private transport error')),
              }
            : createNodeSecureHttpClient({
                allowedPrivateNetworks:
                  parseAllowedPrivateNetworks('127.0.0.1/32'),
              }),
      }),
    ],
  });
  return {
    beforeDispatch,
    assertCurrent,
    write,
    secret,
    run: () =>
      registry.execute({
        definition: HTTP_REQUEST_MANIFEST.definition,
        executor: HTTP_REQUEST_MANIFEST.executor,
        config,
        input: {},
        connectionRefs:
          options.credentials === true ? { http_headers: connectionId } : {},
        runtime,
        signal: options.signal ?? new AbortController().signal,
      }),
  };
}
