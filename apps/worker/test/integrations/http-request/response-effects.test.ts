import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  NodeExecutorFailure,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { executorFailureCompletion } from '../../../src/attempts/delivery/executor-failure.js';
import { createHttpRequestExecutorRegistration } from '@pertexo/integrations/server';
import { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import { createNodeProviderHttpClient } from '../../../src/providers/http-client.js';
import { server } from '../support/pagination.js';

it.each(['size', 'encoding'] as const)(
  'preserves uncertainty after an unsafe effect with an unreadable response (%s)',
  async (failure) => {
    let effects = 0;
    const endpoint = await server((url, request, response) => {
      if (url.pathname !== '/effect' || request.method !== 'POST') {
        response.writeHead(404).end();
        return;
      }
      effects++;
      request.resume();
      response
        .writeHead(200, {
          'content-type': 'text/plain',
          ...(failure === 'encoding' ? { 'content-encoding': 'gzip' } : {}),
        })
        .end('x'.repeat(4096));
    });
    const runtime: NodeExecutionRuntime = {
      workspaceId: randomUUID(),
      runId: randomUUID(),
      nodeRunId: randomUUID(),
      attemptId: randomUUID(),
      attemptNumber: 1,
      nodeId: 'effect',
      invocationKey: 'effect',
      sideEffectClass: 'unsafe',
      beforeDispatch: async () => undefined,
    };
    const failureResult = createHttpRequestExecutorRegistration({
      httpClient: createNodeProviderHttpClient({
        allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
      }),
    }).execute({
      config: {
        method: 'POST',
        url: `${endpoint}/effect`,
        headers: {},
        timeoutMillis: 5000,
        maxRedirects: 0,
        maxResponseBytes: 1024,
        inlineResponseBytes: 1024,
      },
      input: {},
      connectionRefs: {},
      signal: new AbortController().signal,
      runtime,
    });
    const error: unknown = await failureResult.catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      safeErrorCode:
        failure === 'size'
          ? 'http.response_too_large'
          : 'http.response_encoding',
      kind: 'outcome_unknown',
      errorKind: 'provider',
      possiblyDispatched: true,
    });
    if (!(error instanceof NodeExecutorFailure)) throw error;
    expect(executorFailureCompletion(error)).toMatchObject({
      status: 'executor_failure',
      failureKind: 'outcome_unknown',
      errorKind: 'provider',
      possiblyDispatched: true,
      safeErrorCode:
        failure === 'size'
          ? 'http.response_too_large'
          : 'http.response_encoding',
    });
    expect(effects).toBe(1);
  },
);
