import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import {
  NodeExecutorFailure,
  type NodeExecutionRuntime,
  type NodeArtifactRuntime,
} from '@pertexo/node-sdk/server';
import {
  createHttpRequestExecutorRegistration,
  createNodeSecureHttpClient,
  parseAllowedPrivateNetworks,
} from '../../src/server.js';

it.each(['GET', 'POST'] as const)(
  'classifies a failed %s response-file write without retrying an unsafe effect',
  async (method) => {
    let requests = 0;
    const server = createServer((request, response) => {
      // Other software probes new local ports (T3 Code's desktop app sends
      // `GET /`). Those aren't requests the executor made.
      if (request.url !== '/effect') {
        response.writeHead(404).end();
        return;
      }
      requests++;
      request.resume();
      response
        .writeHead(200, { 'content-type': 'application/octet-stream' })
        .end(Buffer.alloc(16384, 7));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing receiver');
      const write = vi.fn<NodeArtifactRuntime['write']>(() =>
        Promise.reject(
          new NodeExecutorFailure({
            kind: 'retry',
            errorKind: 'network',
            possiblyDispatched: false,
            safeErrorCode: 'file.storage_unavailable',
            errorSummary: 'File storage is temporarily unavailable.',
          }),
        ),
      );
      const beforeDispatch = vi.fn<NodeExecutionRuntime['beforeDispatch']>(() =>
        Promise.resolve(),
      );
      const runtime: NodeExecutionRuntime = {
        workspaceId: randomUUID(),
        runId: randomUUID(),
        nodeRunId: randomUUID(),
        attemptId: randomUUID(),
        nodeId: 'post',
        invocationKey: 'post',
        attemptNumber: 1,
        sideEffectClass: 'unsafe',
        beforeDispatch,
        artifacts: { write },
      };
      const executor = createHttpRequestExecutorRegistration({
        httpClient: createNodeSecureHttpClient({
          allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
        }),
      });
      await expect(
        executor.execute({
          config: {
            method,
            url: `http://127.0.0.1:${String(address.port)}/effect`,
            headers: {},
            timeoutMillis: 5000,
            maxRedirects: 0,
            maxResponseBytes: 262144,
            inlineResponseBytes: 1024,
          },
          input: {},
          connectionRefs: {},
          signal: new AbortController().signal,
          runtime,
        }),
      ).rejects.toMatchObject({
        kind: method === 'GET' ? 'retry' : 'outcome_unknown',
        errorKind: 'provider',
        possiblyDispatched: true,
      });
      expect(requests).toBe(1);
      expect(write).toHaveBeenCalledOnce();
      expect(beforeDispatch).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        }),
      );
    }
  },
);
