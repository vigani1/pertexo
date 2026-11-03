import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import { startStack, type Stack } from '../../support/recovery/stack.js';
import { httpChain } from '../../support/recovery/graphs.js';
import { waitForRunsToEnd } from '../../support/recovery/facts.js';

describe.runIf(process.env.WORKER_TRANSPORT_INTEGRATION === 'true')(
  'stored HTTP credential echoes',
  () => {
    let stack: Stack;
    const secret = 'private-é-ÿ-credential';
    const received: string[] = [];
    const server = createServer((request, response) => {
      const header = String(request.headers['x-private']);
      received.push(header);
      const encoding = request.url === '/latin1' ? 'latin1' : 'utf8';
      response.setHeader(
        'content-type',
        encoding === 'latin1' ? 'application/octet-stream' : 'text/plain',
      );
      response.end(Buffer.from(`before:${header}:after`, encoding));
    });
    let origin: string;
    beforeAll(async () => {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Echo server missing');
      origin = `http://127.0.0.1:${String(address.port)}`;
      stack = await startStack('credential-echo', {
        redisDatabase: 13,
        environment: { AUTH_SIGN_UP_MODE: 'open' },
      });
    }, 120_000);
    afterAll(async () => {
      await stack.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }, 60_000);

    it.each([
      ['latin1', false],
      ['utf8', false],
      ['latin1', true],
      ['utf8', true],
    ] as const)(
      'keeps %s credentials usable and removes their bytes from stored output (artifact=%s)',
      async (encoding, artifact) => {
        const workspaceId = await stack.api.createWorkspace('credential-echo');
        const created = await stack.api.call(
          'POST',
          `/v1/workspaces/${workspaceId}/connections`,
          {
            providerKey: 'http',
            name: 'Header echo',
            credential: {
              type: 'http_headers',
              headers: { 'x-private': secret },
            },
          },
          { 'idempotency-key': randomUUID() },
        );
        expect(created.status, JSON.stringify(created.json)).toBe(201);
        const connectionId = (created.json as { id: string }).id;
        const graph = httpChain([
          { id: 'echo', method: 'GET', url: `${origin}/${encoding}` },
        ]);
        const http = graph.nodes[1];
        if (http === undefined) throw new Error('HTTP step missing');
        const workflowId = await stack.api.publish(
          workspaceId,
          'Echo credential',
          {
            ...graph,
            nodes: [
              graph.nodes[0],
              {
                ...http,
                config: {
                  ...http.config,
                  inlineResponseBytes: artifact ? 1 : 4096,
                },
                connectionRefs: { http_headers: connectionId },
              },
            ],
          },
        );
        const runId = await stack.api.startRun(workspaceId, workflowId);
        expect(
          (await waitForRunsToEnd(stack, [runId], 30_000))[runId]?.status,
        ).toBe('succeeded');
        const [row] = await stack.sql<{
          output_ref: {
            kind: string;
            value: {
              body: {
                kind: string;
                artifactId?: string;
                encoding?: 'utf8' | 'base64';
                value?: string;
              };
            };
          };
        }>(
          "select output_ref from app.node_runs where workflow_run_id=$1 and node_id='echo'",
          [runId],
        );
        if (row === undefined) throw new Error('Stored output missing');
        const body = row.output_ref.value.body;
        let bytes: Buffer;
        if (artifact) {
          expect(body.kind).toBe('artifact');
          const storage = createArtifactStore(parseArtifactStoreConfig());
          try {
            const download = await storage.getStream({
              workspaceId,
              artifactId: body.artifactId ?? '',
            });
            const chunks: Buffer[] = [];
            for await (const chunk of download.body)
              chunks.push(Buffer.from(chunk as Uint8Array));
            bytes = Buffer.concat(chunks);
          } finally {
            storage.close();
          }
        } else {
          expect(body.kind).toBe('inline');
          expect(body.encoding).toBe(encoding === 'latin1' ? 'base64' : 'utf8');
          bytes = Buffer.from(body.value ?? '', body.encoding);
        }
        expect(received.at(-1)).toBe(secret);
        expect(bytes.toString()).toBe('before:[Redacted]:after');
        expect(bytes.includes(Buffer.from(secret, encoding))).toBe(false);
        expect(JSON.stringify(row)).not.toContain(secret);
      },
    );
  },
);
