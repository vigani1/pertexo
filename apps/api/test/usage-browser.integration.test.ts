import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FixtureResourceOwner } from './support/fixture-resource-owner.js';
import { ownEditorBrowserProcess } from './support/editor-browser-process.js';
import { useBetterAuthRealApi } from './support/better-auth-real-api.integration.support.js';

const enabled = process.env.USAGE_BROWSER_INTEGRATION === 'true';
const webOrigin = 'http://127.0.0.1:4174';
const webDirectory = new URL('../../web/', import.meta.url);
const webRequire = createRequire(new URL('package.json', webDirectory));
const receipts = z.object({ instanceId: z.uuid() }).strict();

describe.skipIf(!enabled)('real Usage browser, API and PostgreSQL', () => {
  const owner = new FixtureResourceOwner();
  const openBrowsers = new Set<string>();
  let browserOpened = false;
  let observed = false;
  const api = useBetterAuthRealApi('usage_browser', {
    publicWebOrigin: webOrigin,
    beforeClose: () => owner.close(),
  });

  function ownChild(child: ChildProcess, kind: 'vite' | 'browser') {
    const lifetime = ownEditorBrowserProcess(child, kind, {
      browserDisposed: () => browserOpened && openBrowsers.size === 0,
    });
    owner.acquire(kind, child, () => lifetime.close());
    return child;
  }

  function successfulExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      child.once('error', () => {
        reject(new Error('Owned Usage process failed to start'));
      });
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Owned Usage process exited ${String(code)}`));
      });
    });
  }

  it('renders exact capacity and distinct activity, follows bounded drilldowns and fits mobile', async () => {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    const browser = await api.signIn(email);
    const created = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Usage qualification',
        slug: `usage-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(created.statusCode).toBe(201);
    const workspaceId = created.json<{ id: string }>().id;
    const person = (await api.send('GET', '/v1/users/me', { browser })).json<{
      id: string;
    }>().id;
    const workflowId = randomUUID();
    const versionId = randomUUID();
    const artifactId = randomUUID();
    const inspection = api.database();
    const seed = await inspection.connect();
    try {
      await seed.query('begin');
      await seed.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await seed.query(
        `insert into app.workflows
      (id,workspace_id,name,lifecycle_status,activation_status,created_by)
      values($1,$2,'Usage inspection','active','inactive',$3)`,
        [workflowId, workspaceId, person],
      );
      await seed.query(
        `insert into app.workflow_versions
      (id,workspace_id,workflow_id,version_number,schema_version,graph_json,checksum,
       executable_json,published_by)
      values($1,$2,$3,1,1,'{"schemaVersion":1,"nodes":[],"edges":[],"settings":{}}',
       'wf:v2:sha256:'||repeat('e',64),'{"schemaVersion":2}',$4)`,
        [versionId, workspaceId, workflowId, person],
      );
      for (const [status, age] of [
        ['running', '30 minutes'],
        ['queued', '30 minutes'],
        ['succeeded', '30 minutes'],
        ['failed', '3 hours'],
      ]) {
        await seed.query(
          `insert into app.workflow_runs
        (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at,updated_at)
        values($1,$2,$3,$4,'manual',$5,now()-$6::interval,now()-$6::interval)`,
          [randomUUID(), workspaceId, workflowId, versionId, status, age],
        );
      }
      await seed.query(
        `insert into app.artifacts
      (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at)
      values($1,$2,'user-upload',$3,'text/plain',11,repeat('a',64),'pending',now()+interval '15 minutes')`,
        [
          artifactId,
          workspaceId,
          `workspaces/${workspaceId}/artifacts/${artifactId}`,
        ],
      );
      await seed.query('commit');
    } catch (error: unknown) {
      await seed.query('rollback');
      throw error;
    } finally {
      seed.release();
    }
    const capacity = await api.send(
      'GET',
      `/v1/workspaces/${workspaceId}/usage-capacity`,
      { browser },
    );
    expect(capacity.statusCode).toBe(200);
    expect(capacity.json()).toMatchObject({
      execution: { activeRuns: 1, queuedRuns: 1 },
      artifacts: { chargedBytes: '11', chargedCount: 1 },
    });

    const control = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && path === '/usage-seed') {
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
        response.end(
          JSON.stringify({
            workspaceId,
            workflowId,
            cookies: [
              {
                name: 'pertexo_session',
                value: browser.session,
                url: webOrigin,
              },
              {
                name: 'pertexo_csrf',
                value: encodeURIComponent(browser.csrf),
                url: webOrigin,
              },
            ],
          }),
        );
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 512) request.destroy();
      });
      request.on('end', () => {
        try {
          const payload: unknown = JSON.parse(body);
          if (path === '/usage-evidence') {
            const evidence = z
              .object({
                workspaceId: z.literal(workspaceId),
                observed: z.literal(true),
              })
              .strict()
              .parse(payload);
            observed = evidence.observed;
          } else {
            const { instanceId } = receipts.parse(payload);
            if (path === '/browser-opened') {
              browserOpened = true;
              openBrowsers.add(instanceId);
            } else if (
              path === '/browser-disposed' &&
              openBrowsers.delete(instanceId)
            ) {
              /* Explicit receipt. */
            } else throw new Error('Invalid browser receipt');
          }
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
    });
    owner.acquire(
      'Usage control listener',
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
      throw new Error('Usage control address unavailable');
    const environment = {
      ...process.env,
      PERTEXO_API_PROXY_TARGET: await api.listen(),
      PERTEXO_LIVE_MAIL_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
    };
    const viteCli = join(
      dirname(webRequire.resolve('vite/package.json')),
      'bin/vite.js',
    );
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
    await successfulExit(start([viteCli, 'build'], 'vite'));
    const preview = start(
      [
        viteCli,
        'preview',
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
        throw new Error('Usage preview exited');
      try {
        if ((await fetch(webOrigin, { signal: AbortSignal.timeout(1_000) })).ok)
          break;
      } catch {
        /* Owned listener startup. */
      }
      if (Date.now() >= deadline)
        throw new Error('Usage preview startup deadline');
      await delay(50);
    }
    await successfulExit(
      start(
        [
          webRequire.resolve('@playwright/test/cli'),
          'test',
          '--config',
          'playwright.live.config.ts',
          'usage-capacity.spec.ts',
        ],
        'browser',
      ),
    );
    expect(browserOpened).toBe(true);
    expect(openBrowsers.size).toBe(0);
    expect(observed).toBe(true);
  }, 120_000);
});
