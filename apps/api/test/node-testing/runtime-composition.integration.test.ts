import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createApiWorkflowRuntime } from '../../src/platform/workflow/workflow-runtime.module.js';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import {
  apiBaseUrl,
  redisUrl,
} from '../support/better-auth/api/environment.js';
import { httpNodeTestingGraph } from './node-testing.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'node testing runtime composition',
  () => {
    const api = useBetterAuthRealApi('node_runtime');

    it('serves queued step tests and preparations, then releases the testing database sessions', async () => {
      const email = `testing-${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Testing runtime',
          slug: `testing-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      const workspaceId = workspace.json<{ id: string }>().id;
      const root = `/v1/workspaces/${workspaceId}`;
      const made = await api.send('POST', `${root}/workflows`, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Queued step' },
      });
      expect(made.statusCode, made.payload).toBe(201);
      const workflowId = made.json<{ workflow: { id: string } }>().workflow.id;
      const draft = `${root}/workflows/${workflowId}/draft`;
      const graph = httpNodeTestingGraph();
      const saved = await api.send('PUT', draft, {
        browser,
        headers: {
          'idempotency-key': randomUUID(),
          'if-match': String(made.headers.etag),
        },
        payload: {
          graph: {
            ...graph,
            nodes: graph.nodes.map((node) => ({ ...node, connectionRefs: {} })),
          },
        },
      });
      expect(saved.statusCode, saved.payload).toBe(200);
      const key = randomUUID();
      const execute = () =>
        api.send('POST', `${draft}/nodes/http/test`, {
          browser,
          headers: { 'idempotency-key': key },
          payload: {
            mode: 'test_execute',
            expectedRevision: 2,
            acknowledgeSideEffects: true,
            input: {
              kind: 'manual',
              value: { body: { encoding: 'utf8', value: 'hi' } },
            },
          },
        });
      const started = await execute();
      expect(started.statusCode, started.payload).toBe(202);
      expect(started.json()).toMatchObject({
        preview: {
          disclosure: {
            sideEffectClass: 'unsafe',
            mayContactProvider: true,
            mayCauseExternalSideEffect: true,
            dryRun: 'not_supported',
          },
        },
      });
      const preview = started.json<{ preview: { id: string } }>().preview;
      const replay = await execute();
      expect(replay.statusCode, replay.payload).toBe(202);
      expect(replay.json()).toMatchObject({
        replayed: true,
        preview: { id: preview.id },
      });
      const read = await api.send('GET', `${root}/previews/${preview.id}`, {
        browser,
      });
      expect(read.statusCode, read.payload).toBe(200);
      expect(read.json()).toEqual({
        preview: started.json<{ preview: unknown }>().preview,
      });
      for (const kind of ['tests', 'test-suites']) {
        const prepared = await api.send('GET', `${draft}/${kind}/prepare`, {
          browser,
        });
        expect(prepared.statusCode, prepared.payload).toBe(200);
        expect(prepared.json()).toMatchObject({ draftRevision: 2 });
      }

      const { rows } = await api
        .database()
        .query<{ id: string }>('select id from app.users where email=$1', [
          email,
        ]);
      const actor = rows[0];
      assert(actor);
      const actorId = actor.id;
      const applicationName = `node-testing-close-${randomUUID()}`;
      const url = new URL(apiBaseUrl);
      const connectionString = api.database().options.connectionString;
      assert(connectionString);
      const database = new URL(connectionString);
      url.pathname = database.pathname;
      url.searchParams.set('application_name', applicationName);
      const runtime = await createApiWorkflowRuntime(
        parseDatabaseConfig({ connectionString: url.toString(), max: 2 }),
        api.identity(),
        { redisUrl },
      );
      let closed = false;
      try {
        assert(runtime.nodeTestingDependencies);
        const persistence = runtime.nodeTestingDependencies.persistence;
        const scope = { workspaceId, workflowId, actorId };
        expect(await persistence.workflowTests.prepare(scope)).toMatchObject({
          draftRevision: 2,
        });
        expect(
          await persistence.workflowTestSuites.prepare(scope),
        ).toMatchObject({ draftRevision: 2 });
        expect(
          await persistence.readPreview({
            workspaceId,
            actorUserId: actorId,
            previewRunId: preview.id,
          }),
        ).toMatchObject({ id: preview.id });
        const sessions = async () => {
          const result = await api
            .database()
            .query<{ count: number }>(
              'select count(*)::int count from pg_stat_activity where application_name=$1',
              [applicationName],
            );
          return result.rows[0]?.count ?? 0;
        };
        expect(await sessions()).toBeGreaterThan(0);
        await runtime.close();
        closed = true;
        await expect.poll(sessions, { timeout: 5_000 }).toBe(0);
      } finally {
        if (!closed) await runtime.close();
      }
    }, 60_000);
  },
);
