import { Readable } from 'node:stream';
import { HTTP_REQUEST_LIMITS } from '@pertexo/integrations';
import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';
import { describe } from 'vitest';

import { childGraph, edge, fixture, node } from './calls.fixture.js';

export const describeIntegration = fixture.enabled ? describe : describe.skip;

export function childWithHeldHttpResponse() {
  const responseReady = Promise.withResolvers<undefined>();
  const child = childGraph();
  const graph = {
    ...child,
    nodes: [
      ...child.nodes,
      {
        ...node('request', 'http.request'),
        config: {
          method: 'GET',
          url: 'https://child.example.test/',
          headers: {},
          timeoutMillis: HTTP_REQUEST_LIMITS.defaultTimeoutMillis,
          maxRedirects: 0,
          maxResponseBytes: HTTP_REQUEST_LIMITS.defaultInlineResponseBytes,
          inlineResponseBytes: HTTP_REQUEST_LIMITS.defaultInlineResponseBytes,
        },
      },
    ],
    edges: [edge('manual', 'request'), edge('request', 'finish')],
  };
  const registry = createPlatformNodeRegistry({
    httpRequest: {
      httpClient: {
        redactText: (value) => value,
        executeStreaming: async (request, consume) => {
          await request.beforeDispatch();
          await responseReady.promise;
          const response = {
            status: 200,
            headers: {},
            body: Readable.from([]),
            bodyEncoding: 'utf8' as const,
            finalUrl: request.url,
            redirectCount: 0,
            signal: request.signal ?? new AbortController().signal,
          };
          return { ...response, body: await consume(response) };
        },
      },
    },
  });
  return {
    graph,
    registry,
    respond() {
      responseReady.resolve(undefined);
    },
  };
}
