import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from '../../support/recovery/stack.js';
import { httpChain } from '../../support/recovery/graphs.js';
import { waitForRunsToEnd } from '../../support/recovery/facts.js';

const secret = 'synthetic-"private\\response-é';
const cases = [
  [
    'empty-charset',
    'http.response_encoding',
    'unsupported or invalid text encoding',
  ],
  [
    'invalid-bytes',
    'http.response_encoding',
    'unsupported or invalid text encoding',
  ],
  [
    'work-limit',
    'http.response_redaction_limit',
    'credential masking work limit',
  ],
] as const;

describe.runIf(process.env.WORKER_TRANSPORT_INTEGRATION === 'true')(
  'retained HTTP response refusals',
  () => {
    let stack: Stack;
    let origin: string;
    const server = createServer((request, response) => {
      const path = request.url?.split('?')[0];
      response.setHeader(
        'content-type',
        path === '/empty-charset'
          ? 'text/plain; charset='
          : 'text/plain; charset=utf-16le',
      );
      if (path === '/work-limit') {
        response.setHeader('content-type', 'application/json');
        let body =
          '"' +
          String.raw`\u0061`.repeat(Math.floor((10_485_760 - 100) / 13)) +
          '"';
        for (let layer = 1; layer < 4; layer += 1) body = JSON.stringify(body);
        response.end(body);
      } else {
        const body = Buffer.from(
          JSON.stringify({ credential: secret, padding: 'x'.repeat(100_000) }),
          'utf16le',
        );
        response.end(
          path === '/invalid-bytes'
            ? Buffer.concat([body, Buffer.of(255)])
            : body,
        );
      }
    });
    beforeAll(async () => {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing stand-in');
      origin = `http://127.0.0.1:${String(address.port)}`;
      stack = await startStack('response-refusals', {
        redisDatabase: 13,
        environment: { AUTH_SIGN_UP_MODE: 'open' },
      });
    }, 120_000);
    afterAll(async () => {
      await stack.close();
      server.close();
      await once(server, 'close');
    }, 60_000);

    it.each(
      cases.flatMap(([path, code, reason]) =>
        [false, true].map((artifact) => ({ path, code, reason, artifact })),
      ),
    )(
      'shows the service refusal for $path, artifact=$artifact, with no retained file',
      async ({ path, code, reason, artifact }) => {
        const workspaceId = await stack.api.createWorkspace('response-refusal');
        const credential =
          path === 'work-limit' ? 'a'.repeat(7990) + 'b' : secret;
        const connection = await stack.api.call(
          'POST',
          `/v1/workspaces/${workspaceId}/connections`,
          {
            providerKey: 'http',
            name: 'Response refusal',
            credential: {
              type: 'http_headers',
              headers: { 'x-private': credential },
            },
          },
          { 'idempotency-key': randomUUID() },
        );
        expect(connection.status, JSON.stringify(connection.json)).toBe(201);
        const connectionId = (connection.json as { id: string }).id;
        const graph = httpChain([
          { id: 'echo', method: 'GET', url: `${origin}/${path}` },
        ]);
        const step = graph.nodes[1];
        if (step === undefined) throw new Error('Missing HTTP step');
        const workflowId = await stack.api.publish(
          workspaceId,
          'Response refusal',
          {
            ...graph,
            nodes: [
              graph.nodes[0],
              {
                ...step,
                config: {
                  ...step.config,
                  maxResponseBytes: 10_485_760,
                  inlineResponseBytes: artifact ? 1 : 262_144,
                },
                connectionRefs: { http_headers: connectionId },
              },
            ],
          },
        );
        const runId = await stack.api.startRun(workspaceId, workflowId);
        expect(
          (await waitForRunsToEnd(stack, [runId], 30_000))[runId]?.status,
        ).toBe('failed');
        const facts = await stack.sql<{
          safe_error_code: string;
          error_summary: string;
          output_ref: unknown;
        }>(
          "select a.safe_error_code,a.error_summary,n.output_ref from app.node_attempts a join app.node_runs n on n.current_attempt_id=a.id where n.workflow_run_id=$1 and n.node_id='echo'",
          [runId],
        );
        expect(facts).toHaveLength(1);
        expect(facts[0]).toMatchObject({
          safe_error_code: code,
          output_ref: null,
        });
        expect(facts[0]?.error_summary).toContain(reason);
        const detail = await stack.api.call(
          'GET',
          `/v1/workspaces/${workspaceId}/runs/${runId}`,
        );
        expect(detail.status).toBe(200);
        expect(JSON.stringify(detail.json)).toContain(code);
        expect(JSON.stringify(detail.json)).toContain(reason);
        expect(JSON.stringify(detail.json)).not.toContain(secret);
        const files = await stack.sql(
          "select id from app.artifacts where workspace_id=$1 and status='available'",
          [workspaceId],
        );
        expect(files).toEqual([]);
      },
      45_000,
    );
  },
);
