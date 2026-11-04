import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import { httpChain } from '../../support/recovery/graphs.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';
import { waitForRunsToEnd } from '../../support/recovery/facts.js';

const secret = 'synthetic-"quote\\credential-é';
const echoes = {
  literal: secret,
  unicode: Array.from(
    secret,
    (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
  ).join(''),
  percent: encodeURIComponent(secret),
  base64: Buffer.from(secret).toString('base64'),
  nested: JSON.stringify({
    echo: JSON.stringify({ echo: JSON.stringify({ echo: secret }) }),
  }),
};

const maskedEchoes = {
  literal: '[Redacted]',
  unicode: '[Redacted]',
  percent: '[Redacted]',
  base64: '[Redacted]',
  nested: JSON.stringify({
    echo: JSON.stringify({ echo: JSON.stringify({ echo: '[Redacted]' }) }),
  }),
};

describe.runIf(process.env.WORKER_TRANSPORT_INTEGRATION === 'true')(
  'credential masking after real worker retention',
  () => {
    let stack: Stack;
    let origin: string;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(String(request.headers['x-private']));
      const path = new URL(request.url ?? '/', 'http://echo.test').pathname;
      response.statusCode = path === '/error' ? 400 : 200;
      response.setHeader(
        'content-type',
        path === '/invalid-charset'
          ? 'application/json; charset=not-a-character-set'
          : 'application/json; charset=utf-16le',
      );
      response.setHeader('etag', echoes.percent);
      const body = Buffer.from(
        JSON.stringify({ items: [echoes], next: null }),
        'utf16le',
      );
      // Escapes and UTF-16 code units cross transport chunks.
      for (let offset = 0; offset < body.length; offset += 7)
        response.write(body.subarray(offset, offset + 7));
      response.end();
    });

    beforeAll(async () => {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Echo server missing');
      origin = `http://127.0.0.1:${String(address.port)}`;
      stack = await startStack('retained-encodings', {
        redisDatabase: 13,
        environment: { AUTH_SIGN_UP_MODE: 'open' },
      });
    }, 120_000);

    afterAll(async () => {
      await stack.close();
      server.close();
      await once(server, 'close');
    }, 60_000);

    it.each([
      'inline',
      'artifact',
      'pages',
      'error',
      'invalid-charset',
    ] as const)(
      'retains only masked data through %s, including four JSON decoding layers',
      async (path) => {
        const workspaceId = await stack.api.createWorkspace('retained-masking');
        const created = await stack.api.call(
          'POST',
          `/v1/workspaces/${workspaceId}/connections`,
          {
            providerKey: 'http',
            name: 'Encoded echo',
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
          { id: 'echo', method: 'GET', url: `${origin}/${path}` },
        ]);
        const step = graph.nodes[1];
        if (step === undefined) throw new Error('Missing HTTP step');
        const workflowId = await stack.api.publish(
          workspaceId,
          'Retained encoding proof',
          {
            ...graph,
            nodes: [
              graph.nodes[0],
              {
                ...step,
                config: {
                  ...step.config,
                  inlineResponseBytes: path === 'artifact' ? 1 : 4096,
                  ...(path === 'pages'
                    ? {
                        pagination: {
                          mode: 'next_link',
                          source: { kind: 'body', path: '$.next' },
                          itemsPath: '$.items',
                          outputMode: 'pages',
                          maxPages: 2,
                        },
                      }
                    : {}),
                },
                connectionRefs: { http_headers: connectionId },
              },
            ],
          },
        );
        const runId = await stack.api.startRun(workspaceId, workflowId);
        const failure = path === 'error' || path === 'invalid-charset';
        expect(
          (await waitForRunsToEnd(stack, [runId], 30_000))[runId]?.status,
        ).toBe(failure ? 'failed' : 'succeeded');
        const rows = await stack.sql<{
          output_ref: unknown;
          error_summary: string | null;
          safe_error_code: string | null;
        }>(
          "select n.output_ref,a.error_summary,a.safe_error_code from app.node_runs n left join app.node_attempts a on a.id=n.current_attempt_id where n.workflow_run_id=$1 and n.node_id='echo'",
          [runId],
        );
        expect(rows).toHaveLength(1);
        expect(requests.at(-1)).toBe(secret);
        const retained = await stack.sql(
          `select to_jsonb(run) run,
          (select jsonb_agg(to_jsonb(n)) from app.node_runs n where n.workflow_run_id=run.id) nodes,
          (select jsonb_agg(to_jsonb(a)) from app.node_attempts a join app.node_runs n on n.id=a.node_run_id where n.workflow_run_id=run.id) attempts,
          (select jsonb_agg(to_jsonb(e)) from app.run_events e where e.workflow_run_id=run.id) events
        from app.workflow_runs run where run.id=$1`,
          [runId],
        );
        const contents = await retainedArtifactContents(stack, workspaceId);
        const retainedText = JSON.stringify([retained, contents]);
        for (const value of Object.values(echoes)) {
          expect(retainedText).not.toContain(value);
          expect(retainedText).not.toContain(
            JSON.stringify(value).slice(1, -1),
          );
        }
        const processOutput = JSON.stringify([
          stack.worker.logs,
          stack.apiProcess.logs,
        ]);
        for (const value of Object.values(echoes))
          expect(processOutput).not.toContain(value);
        if (failure) {
          expect(rows[0]?.output_ref).toBeNull();
          expect(rows[0]?.safe_error_code).toEqual(expect.any(String));
          if (path === 'error')
            expect(rows[0]?.error_summary).toContain('[Redacted]');
          expect(contents).toEqual([]);
        } else {
          expect(retainedText).toContain('[Redacted]');
          if (path === 'inline')
            expect(rows[0]?.output_ref).toMatchObject({
              kind: 'inline',
              value: { body: { json: { items: [maskedEchoes] } } },
            });
          if (path === 'artifact' || path === 'pages') {
            expect(contents).toHaveLength(1);
            const payload = JSON.parse(contents[0] ?? '') as unknown;
            expect(payload).toMatchObject(
              path === 'pages' ? [maskedEchoes] : { items: [maskedEchoes] },
            );
          }
        }
      },
    );
  },
);

async function retainedArtifactContents(stack: Stack, workspaceId: string) {
  const storedFiles = await stack.sql<{ id: string }>(
    "select id from app.artifacts where workspace_id=$1 and status='available'",
    [workspaceId],
  );
  const contents: string[] = [];
  const storage = createArtifactStore(parseArtifactStoreConfig());
  try {
    for (const file of storedFiles) {
      const download = await storage.getStream({
        workspaceId,
        artifactId: file.id,
      });
      const chunks: Buffer[] = [];
      for await (const chunk of download.body)
        chunks.push(Buffer.from(chunk as Uint8Array));
      contents.push(Buffer.concat(chunks).toString('utf8'));
    }
  } finally {
    storage.close();
  }

  return contents;
}
