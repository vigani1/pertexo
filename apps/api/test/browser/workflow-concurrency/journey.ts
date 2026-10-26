import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { workflowRunResponseSchema } from '@pertexo/contracts';

import { restartEditorBrowserWorker } from '../harness/worker-restart.js';

import { webOrigin, webDirectory, webRequire } from './environment.js';
import { successfulExit } from './process.js';
import { liveWebPort } from '../web-origin.js';
import type { createWorkflowConcurrencyJourney } from './fixture.js';

export function registerWorkflowConcurrencyJourney(
  fixture: ReturnType<typeof createWorkflowConcurrencyJourney>,
): void {
  const { api, scope, openBrowsers, pendingCommands, owner, own } = fixture;
  it('starts one wait at cap one, survives runtime restart, and starts the second only after browser removal', async () => {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    const browser = await api.signIn(email);
    const created = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Concurrency qualification',
        slug: `concurrency-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(created.statusCode, created.payload).toBe(201);
    const workspaceId = created.json<{ id: string }>().id;
    const workflow = await api.send(
      'POST',
      `/v1/workspaces/${workspaceId}/workflows`,
      {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Ordered wait workflow' },
      },
    );
    expect(workflow.statusCode, workflow.payload).toBe(201);
    const workflowId = workflow.json<{ workflow: { id: string } }>().workflow
      .id;
    const route = `/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
    const draft = await api.send('GET', `${route}/draft`, { browser });
    const nodeId = randomUUID();
    const saved = await api.send('PUT', `${route}/draft`, {
      browser,
      headers: { 'if-match': String(draft.headers.etag) },
      payload: {
        graph: {
          nodes: [
            {
              id: nodeId,
              definition: { key: 'core.wait', version: 1 },
              label: 'Hold the active slot',
              position: { x: 0, y: 0 },
              configVersion: 1,
              config: { durationSeconds: 600 },
              inputMappings: {},
              connectionRefs: {},
            },
          ],
          edges: [],
          settings: {},
        },
      },
    });
    expect(saved.statusCode, saved.payload).toBe(200);
    const published = await api.send('POST', `${route}/publish`, {
      browser,
      headers: {
        'if-match': String(saved.headers.etag),
        'idempotency-key': randomUUID(),
      },
    });
    expect(published.statusCode, published.payload).toBe(200);
    const runs: string[] = [];
    async function readRun(id: string) {
      scope.signal.throwIfAborted();
      const reply = await api.send(
        'GET',
        `/v1/workspaces/${workspaceId}/runs/${id}`,
        { browser },
      );
      scope.signal.throwIfAborted();
      expect(reply.statusCode, reply.payload).toBe(200);
      return workflowRunResponseSchema.parse(reply.json());
    }
    async function waitFor(id: string, status: 'waiting' | 'queued') {
      const deadline = Date.now() + 15_000;
      for (;;) {
        scope.signal.throwIfAborted();
        const result = await readRun(id);
        if (result.run.status === status) return result;
        if (Date.now() >= deadline)
          throw new Error('Real concurrency run transition deadline');
        await delay(50, undefined, { signal: scope.signal });
      }
    }
    async function blocked() {
      const first = await waitFor(runs[0] ?? '', 'waiting');
      const second = await waitFor(runs[1] ?? '', 'queued');
      expect(first.nodes).toHaveLength(1);
      expect(second.nodes).toHaveLength(0);
      expect(second.run.admissionBlockers?.reasons).toContain(
        'workflow_capacity',
      );
      const counts = await api
        .database()
        .query<{ count: number }>(
          'select count(*)::int count from app.node_runs where workspace_id=$1 and workflow_run_id=$2',
          [workspaceId, runs[1]],
        );
      expect(counts.rows[0]?.count).toBe(0);
    }
    async function controlCommand(path: string) {
      scope.signal.throwIfAborted();
      if (path === '/start-runs') {
        if (runs.length !== 0) throw new Error('Runs already accepted');
        for (let index = 0; index < 2; index++) {
          scope.signal.throwIfAborted();
          const accepted = await api.send('POST', `${route}/runs`, {
            browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { input: {} },
          });
          expect(accepted.statusCode, accepted.payload).toBe(202);
          runs.push(accepted.json<{ run: { id: string } }>().run.id);
        }
        await blocked();
        return { runs };
      }
      if (path === '/restart') {
        await restartEditorBrowserWorker(
          fixture.worker as Parameters<typeof restartEditorBrowserWorker>[0],
          randomUUID(),
          scope.signal,
        );
        await delay(300, undefined, { signal: scope.signal });
        await blocked();
        return { restarted: true };
      }
      if (path === '/refuse-start') {
        const result = await api.send('POST', `${route}/runs`, {
          browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { input: {} },
        });
        expect(result.statusCode, result.payload).toBe(409);
        expect(result.json()).toMatchObject({
          code: 'workflow.already_running',
        });
        return { refused: true };
      }
      if (path !== '/released-evidence')
        throw new Error('Unknown concurrency command');
      const first = await waitFor(runs[0] ?? '', 'waiting'),
        second = await waitFor(runs[1] ?? '', 'waiting');
      expect(first.nodes).toHaveLength(1);
      expect(second.nodes).toHaveLength(1);
      expect(first.run.startedAt).not.toBeNull();
      expect(second.run.startedAt).not.toBeNull();
      expect(String(first.run.startedAt) < String(second.run.startedAt)).toBe(
        true,
      );
      fixture.observed = true;
      return { observed: true };
    }
    const control = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && path === '/concurrency-seed') {
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
      if (path === '/browser-opened' || path === '/browser-disposed') {
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 512) request.destroy();
        });
        request.on('end', () => {
          try {
            const { instanceId } = z
              .object({ instanceId: z.uuid() })
              .strict()
              .parse(JSON.parse(body));
            if (path === '/browser-opened') {
              fixture.opened = true;
              openBrowsers.add(instanceId);
            } else if (!openBrowsers.delete(instanceId))
              throw new Error('Unknown browser');
            response.writeHead(204).end();
          } catch {
            response.writeHead(400).end();
          }
        });
        return;
      }
      if (scope.signal.aborted) {
        response.writeHead(503).end();
        return;
      }
      const command = Promise.resolve()
        .then(() => controlCommand(path))
        .then(
          (result) => {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(result));
          },
          () => {
            response.writeHead(500).end('Owned concurrency evidence failed');
          },
        );
      pendingCommands.add(command);
      const settled = () => {
        pendingCommands.delete(command);
      };
      void command.then(settled, settled);
    });
    owner.acquire('concurrency control', control, async () => {
      await Promise.allSettled([...pendingCommands]);
      await new Promise<void>((resolve, reject) => {
        control.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(0, '127.0.0.1', resolve);
    });
    const address = control.address();
    if (address === null || typeof address === 'string')
      throw new Error('Owned control address unavailable');
    const environment = {
      ...process.env,
      PERTEXO_API_PROXY_TARGET: await api.listen(),
      PERTEXO_LIVE_MAIL_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
      PERTEXO_LIVE_WEB_ORIGIN: webOrigin,
    };
    const start = (args: string[], kind: 'vite' | 'browser') =>
      own(
        spawn(process.execPath, args, {
          cwd: webDirectory,
          env:
            kind === 'vite'
              ? { ...environment, NODE_ENV: 'production' }
              : environment,
          stdio: 'ignore',
          detached: true,
        }),
        kind,
      );
    const vite = join(
      dirname(webRequire.resolve('vite/package.json')),
      'bin/vite.js',
    );
    await successfulExit(start([vite, 'build'], 'vite'));
    const preview = start(
      [
        vite,
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(liveWebPort),
        '--strictPort',
      ],
      'vite',
    );
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (preview.exitCode !== null || preview.signalCode !== null)
        throw new Error('Owned preview exited');
      try {
        if ((await fetch(webOrigin, { signal: AbortSignal.timeout(1000) })).ok)
          break;
      } catch {
        /* Owned startup only. */
      }
      if (Date.now() > deadline)
        throw new Error('Owned preview startup deadline');
      await delay(50);
    }
    await successfulExit(
      start(
        [
          webRequire.resolve('@playwright/test/cli'),
          'test',
          '--config',
          'playwright.live.config.ts',
          'workflow-concurrency.spec.ts',
        ],
        'browser',
      ),
    );
    expect(fixture.opened).toBe(true);
    expect(openBrowsers.size).toBe(0);
    expect(fixture.observed).toBe(true);
  }, 120_000);
}
