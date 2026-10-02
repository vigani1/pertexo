import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FixtureResourceOwner } from './support/fixture-resource-owner.js';
import { ownEditorBrowserProcess } from './support/editor-browser-process.js';
import { useOrganizationOwnedApi } from './support/workflow-organization-owned-api.fixture.js';

const enabled =
  process.env.F07_ORGANIZATION_BROWSER_INTEGRATION === 'true' &&
  process.env.F07_ORGANIZATION_OWNED_FIXTURE === 'true';
const webOrigin = 'http://127.0.0.1:4174';
const webDirectory = new URL('../../web/', import.meta.url);
const webRequire = createRequire(new URL('package.json', webDirectory));
const evidenceSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowIds: z.array(z.uuid()).length(2),
    folderId: z.uuid(),
    tagId: z.uuid(),
  })
  .strict();

describe.skipIf(!enabled)(
  'owned F07 ordinary browser and real organization API',
  () => {
    const owner = new FixtureResourceOwner();
    const openBrowsers = new Set<string>();
    const barriers: ReturnType<typeof ownEditorBrowserProcess>[] = [];
    const pending = new Set<Promise<void>>();
    let opened = false;
    let observed = false;
    let closing = false;
    let browserPhase = 'startup';
    let failureLine = 0;
    const { api } = useOrganizationOwnedApi('organization_browser', {
      publicWebOrigin: webOrigin,
      beforeClose: async () => {
        closing = true;
        await Promise.allSettled([...pending]);
        // A failed descendant barrier stops cleanup before the aggregate owner
        // can release the control listener. The API fixture preserves its DB.
        for (const barrier of barriers.toReversed()) await barrier.close();
        await owner.close();
      },
    });
    function ownChild(child: ChildProcess, kind: 'vite' | 'browser') {
      const barrier = ownEditorBrowserProcess(child, kind, {
        browserDisposed: () => opened && openBrowsers.size === 0,
      });
      barriers.push(barrier);
      return owner.acquire(kind, child, () => barrier.close());
    }
    function successfulExit(child: ChildProcess, phase: string) {
      return new Promise<void>((resolve, reject) => {
        child.once('error', () => {
          reject(new Error(`Owned F07 ${phase} startup failed`));
        });
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Owned F07 ${phase} exited unsuccessfully at ${browserPhase} line ${String(failureLine)}`,
              ),
            );
        });
      });
    }
    it('qualifies ordinary owner management, filters, private favorite and exact bounded recovery', async () => {
      async function verifyEvidence(value: unknown) {
        const evidence = evidenceSchema.parse(value);
        const rows = await api.database().query<{
          workflow_id: string;
          folder_id: string | null;
          revision: string;
        }>('select workflow_id,folder_id,revision from app.workflow_organization_state where workspace_id=$1 and workflow_id=any($2::uuid[]) order by workflow_id', [evidence.workspaceId, evidence.workflowIds]);
        expect(rows.rows).toHaveLength(2);
        expect(
          rows.rows.every((row) => row.folder_id === evidence.folderId),
        ).toBe(true);
        const folder = await api
          .database()
          .query<{ name: string; parent_id: string | null; revision: string }>(
            'select name,parent_id,revision from app.workflow_folders where workspace_id=$1 and id=$2',
            [evidence.workspaceId, evidence.folderId],
          );
        expect(folder.rows[0]).toMatchObject({
          name: 'Delivery',
          parent_id: null,
        });
        expect(Number(folder.rows[0]?.revision)).toBeGreaterThanOrEqual(3);
        const tags = await api
          .database()
          .query<{ count: number }>(
            'select count(*)::int count from app.workflow_tag_assignments where workspace_id=$1 and tag_id=$2',
            [evidence.workspaceId, evidence.tagId],
          );
        expect(tags.rows[0]?.count).toBe(0);
        const favorites = await api
          .database()
          .query<{ count: number }>(
            'select count(*)::int count from app.workflow_favorites where workspace_id=$1 and workflow_id=$2 and favorite',
            [evidence.workspaceId, evidence.workflowIds[0]],
          );
        expect(favorites.rows[0]?.count).toBe(1);
        const receipt = await api
          .database()
          .query<{ count: number }>(
            "select count(*)::int count from app.workflow_organization_receipts where workspace_id=$1 and operation='organization.batch.identity' and admission_xid is not null",
            [evidence.workspaceId],
          );
        expect(receipt.rows[0]?.count).toBeGreaterThanOrEqual(2);
        observed = true;
      }
      const control = createServer((request, response) => {
        response.setHeader('cache-control', 'no-store');
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (
          closing &&
          !['/browser-opened', '/browser-disposed'].includes(url.pathname)
        ) {
          response.writeHead(503).end();
          return;
        }
        if (request.method === 'GET' && url.pathname === '/verification') {
          try {
            const link = api.mailedLink(
              url.searchParams.get('email') ?? '',
              'verification',
            );
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ path: link.pathname + link.search }));
          } catch {
            response.writeHead(404).end();
          }
          return;
        }
        if (
          request.method !== 'POST' ||
          ![
            '/browser-opened',
            '/browser-disposed',
            '/organization-evidence',
            '/organization-phase',
            '/organization-failure',
          ].includes(url.pathname)
        ) {
          response.writeHead(404).end();
          return;
        }
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 2048) request.destroy();
        });
        request.on('end', () => {
          const command = Promise.resolve()
            .then(async () => {
              const value: unknown = JSON.parse(body);
              if (url.pathname === '/organization-failure') {
                failureLine = z
                  .object({ line: z.number().int().min(0).max(1000) })
                  .strict()
                  .parse(value).line;
              } else if (url.pathname === '/organization-phase') {
                browserPhase = z
                  .object({
                    phase: z.enum([
                      'registration',
                      'workspace',
                      'workflows',
                      'workflow-navigation',
                      'workflow-open',
                      'workflow-name',
                      'workflow-submit',
                      'workflow-result',
                      'workflow-created',
                      'workflow-create-rejected',
                      'folders',
                      'manager',
                      'tags',
                      'placement',
                      'filters',
                      'unfile',
                      'bulk',
                      'cleanup',
                      'evidence',
                    ]),
                  })
                  .strict()
                  .parse(value).phase;
              } else if (url.pathname === '/organization-evidence')
                await verifyEvidence(value);
              else {
                const { instanceId } = z
                  .object({ instanceId: z.uuid() })
                  .strict()
                  .parse(value);
                if (url.pathname === '/browser-opened') {
                  if (openBrowsers.has(instanceId))
                    throw new Error('Duplicate browser receipt');
                  opened = true;
                  openBrowsers.add(instanceId);
                } else if (!openBrowsers.delete(instanceId))
                  throw new Error('Unknown browser receipt');
              }
              response.writeHead(204).end();
            })
            .catch(() => {
              response.writeHead(500).end('Owned organization evidence failed');
            });
          pending.add(command);
          void command.finally(() => {
            pending.delete(command);
          });
        });
      });
      owner.acquire(
        'organization control listener',
        control,
        () =>
          new Promise<void>((resolve, reject) => {
            control.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
      );
      await new Promise<void>((resolve, reject) => {
        control.once('error', reject);
        control.listen(0, '127.0.0.1', resolve);
      });
      const address = control.address();
      if (address === null || typeof address === 'string')
        throw new Error('Owned organization listener unavailable');
      const environment = {
        ...process.env,
        EDITOR_BROWSER_INTEGRATION: 'true',
        EDITOR_BROWSER_CASE: 'workflow-organization',
        EDITOR_BROWSER_OWNED_FIXTURE: 'true',
        PERTEXO_API_PROXY_TARGET: await api.listen(),
        PERTEXO_LIVE_MAIL_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
      };
      const start = (args: string[], kind: 'vite' | 'browser') =>
        ownChild(
          spawn(process.execPath, args, {
            cwd: webDirectory,
            env: environment,
            stdio: 'ignore',
            detached: true,
          }),
          kind,
        );
      const vite = join(
        dirname(webRequire.resolve('vite/package.json')),
        'bin/vite.js',
      );
      const qualification = [
        '--config',
        'vite.organization-qualification.config.ts',
        '--mode',
        'workflow-organization-qualification',
      ];
      await successfulExit(
        start([vite, 'build', ...qualification], 'vite'),
        'build',
      );
      const preview = start(
        [
          vite,
          'preview',
          ...qualification,
          '--host',
          '127.0.0.1',
          '--port',
          '4174',
          '--strictPort',
        ],
        'vite',
      );
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (preview.exitCode !== null || preview.signalCode !== null)
          throw new Error('Owned organization preview exited');
        try {
          if (
            (await fetch(webOrigin, { signal: AbortSignal.timeout(1000) })).ok
          )
            break;
        } catch {
          /* Owned startup only. */
        }
        if (Date.now() >= deadline)
          throw new Error('Owned organization preview startup deadline');
        await delay(50);
      }
      await successfulExit(
        start(
          [
            webRequire.resolve('@playwright/test/cli'),
            'test',
            '--config',
            'playwright.live.config.ts',
            'workflow-organization.spec.ts',
          ],
          'browser',
        ),
        'browser',
      );
      expect(opened).toBe(true);
      expect(openBrowsers.size).toBe(0);
      expect(observed).toBe(true);
    }, 180_000);
  },
);
