import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  apiTokenCreateResponseSchema,
  workflowExportResponseSchema,
} from '@pertexo/contracts';
import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import { createAutomationApiFixture } from './api/api-token-api.fixture.js';
import { createTokenWorkspace } from './api/portability/setup.js';

const execute = promisify(execFile);

describe.runIf(betterAuthIntegrationEnabled)(
  'public workflow list summary authority',
  () => {
    const fixture = createAutomationApiFixture();
    const { api } = fixture;
    let world: Awaited<ReturnType<typeof createTokenWorkspace>>;
    beforeAll(async () => {
      world = await createTokenWorkspace(fixture);
    }, 120_000);

    it('omits recent runs for a workflow-only token while retaining topology', async () => {
      const created = await api.send('POST', `${world.base}/api-tokens`, {
        browser: world.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Workflow reader', scopes: ['workflow:read'] },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const token = apiTokenCreateResponseSchema.parse(created.json());
      if (token.replayed) throw new Error('Unexpected token replay');
      const headers = { authorization: `Bearer ${token.secret}` };
      const response = await api.send(
        'GET',
        `${world.base}/workflows?include=listSummary`,
        { headers },
      );
      expect(response.statusCode, response.payload).toBe(200);
      const page = response.json<{
        items: {
          id: string;
          listSummary: { shape: { nodes: object[] }; recentRuns?: unknown };
        }[];
      }>();
      expect(page.items.map((item) => item.id)).toEqual([world.workflowId]);
      expect(page.items[0]?.listSummary.shape.nodes).toHaveLength(1);
      expect(page.items[0]?.listSummary).not.toHaveProperty('recentRuns');
      const denied = await api.send('GET', `${world.base}/runs`, { headers });
      expect(denied.statusCode).toBe(403);
    });

    it.skipIf(process.env.PERTEXO_CLI_TEST_IMAGE === undefined)(
      'runs documented compiled CLI reads and mounted review export in the release image',
      async () => {
        const origin = await fixture.listen();
        const published = await api.send(
          'POST',
          `${world.base}/workflows/${world.workflowId}/publish`,
          {
            headers: {
              ...world.headers,
              'idempotency-key': randomUUID(),
              'if-match': String(world.saved.headers.etag),
            },
          },
        );
        expect(published.statusCode, published.payload).toBe(200);
        const env = {
          ...process.env,
          PERTEXO_API_URL: origin,
          PERTEXO_API_TOKEN: world.first.secret,
        };
        const local = async (args: string[]) =>
          JSON.parse(
            (
              await execute(
                process.execPath,
                ['apps/cli/dist/main.js', ...args],
                { cwd: new URL('../../../../', import.meta.url), env },
              )
            ).stdout,
          ) as Record<string, unknown>;
        const args = [
          '--workspace',
          world.workspaceId,
          '--workflow',
          world.workflowId,
        ];
        const draft = await local(['workflows', 'draft', ...args]);
        expect(draft.graphDigest).toEqual(expect.any(String));
        expect(await local(['workflows', 'versions', ...args])).toMatchObject({
          items: [{ graphDigest: draft.graphDigest }],
        });
        const directory = await mkdtemp(join(tmpdir(), 'pertexo-j4-cli-'));
        try {
          await chmod(directory, 0o755);
          await writeFile(
            join(directory, 'export.json'),
            JSON.stringify({
              source: { kind: 'draft' },
              reviewedGraphDigest: draft.graphDigest,
            }),
          );
          const imageUrl = origin.replace('127.0.0.1', 'localhost');
          const imageEnv = { ...env, PERTEXO_API_URL: imageUrl };
          const container = [
            'run',
            '--rm',
            '--add-host',
            'localhost:host-gateway',
            '-i',
            '--entrypoint',
            'node',
            '-e',
            'PERTEXO_API_URL',
            '-e',
            'PERTEXO_API_TOKEN',
            '-v',
            `${directory}:/input:ro`,
            process.env.PERTEXO_CLI_TEST_IMAGE ?? '',
            '--dns-result-order=ipv4first',
            'apps/cli/dist/main.js',
          ];
          const identity = await execute('docker', [...container, 'whoami'], {
            env: imageEnv,
          });
          expect(JSON.parse(identity.stdout)).toMatchObject({
            workspaceId: world.workspaceId,
          });
          const result = await execute(
            'docker',
            [
              ...container,
              'workflows',
              'export',
              ...args,
              '--body',
              '/input/export.json',
              '--etag',
              String(draft.etag),
            ],
            { env: imageEnv },
          );
          const manifest = workflowExportResponseSchema.parse(
            JSON.parse(result.stdout),
          );
          expect(manifest.graph.nodes).toHaveLength(1);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      120_000,
    );

    it('keeps archived workflow summaries readable and respects explicit view filters', async () => {
      const archived = await api.send(
        'POST',
        `${world.base}/workflows/${world.workflowId}/archive`,
        {
          browser: world.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { expectedLifecycleRevision: 1 },
        },
      );
      expect(archived.statusCode, archived.payload).toBe(202);
      const active = await api.send(
        'GET',
        `${world.base}/workflows?include=organization,listSummary&view=active`,
        { headers: world.headers },
      );
      expect(active.statusCode, active.payload).toBe(200);
      expect(active.json<{ items: object[] }>().items).toEqual([]);
      const response = await api.send(
        'GET',
        `${world.base}/workflows?include=organization,listSummary&view=archived`,
        { headers: world.headers },
      );
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.json()).toMatchObject({
        items: [
          {
            workflow: {
              id: world.workflowId,
              lifecycleStatus: 'archived',
              listSummary: {
                shape: { nodes: [expect.any(Object)] },
                recentRuns: [],
              },
            },
          },
        ],
      });
    });
  },
);
