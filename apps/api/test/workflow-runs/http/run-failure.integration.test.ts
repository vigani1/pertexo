import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRunFailureStore } from '@pertexo/core/runs';
import {
  parseDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database/platform';
import {
  workflowRunResponseSchema,
  workflowRunListResponseSchema,
} from '@pertexo/contracts';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';
import { apiBaseUrl } from '../../support/better-auth/api/environment.js';

let config: DatabaseConfig | undefined;
const api = useBetterAuthRealApi('run_failure_reason', {
  afterMigration: (url) => {
    config = parseDatabaseConfig({ connectionString: url(apiBaseUrl) });
    return Promise.resolve();
  },
});
describe.runIf(betterAuthIntegrationEnabled)(
  'safe run-level failure over HTTP',
  () => {
    it('returns the authoritative emergency cause through Get and List without a failed step', async () => {
      if (config === undefined) throw new Error('Database fixture missing');
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const browser = await api.signIn(email);
      const createdWorkspace = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Run diagnosis', slug: `diagnosis-${randomUUID()}` },
      });
      expect(createdWorkspace.statusCode, createdWorkspace.payload).toBe(201);
      const workspaceId = createdWorkspace.json<{ id: string }>().id;
      const base = `/v1/workspaces/${workspaceId}`;
      const created = await api.send('POST', `${base}/workflows`, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Run diagnosis' },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const workflowId = created.json<{ workflow: { id: string } }>().workflow
        .id;
      const path = `${base}/workflows/${workflowId}`;
      const saved = await api.send('PUT', `${path}/draft`, {
        browser,
        headers: { 'if-match': String(created.headers.etag) },
        payload: {
          graph: {
            settings: {},
            edges: [],
            nodes: [
              {
                id: randomUUID(),
                definition: { key: 'core.manual', version: 1 },
                configVersion: 1,
                config: {},
                inputMappings: {},
                connectionRefs: {},
                position: { x: 0, y: 0 },
              },
            ],
          },
        },
      });
      expect(saved.statusCode, saved.payload).toBe(200);
      const published = await api.send('POST', `${path}/publish`, {
        browser,
        headers: {
          'if-match': String(saved.headers.etag),
          'idempotency-key': randomUUID(),
        },
        payload: {},
      });
      expect(published.statusCode, published.payload).toBe(200);
      const started = await api.send('POST', `${path}/runs`, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { input: {} },
      });
      expect(started.statusCode, started.payload).toBe(202);
      const runId = started.json<{ run: { id: string } }>().run.id;
      await api
        .database()
        .query(
          `update app.run_checkpoints set scheduler_state=jsonb_set(scheduler_state,'{nextEventSequence}','"damaged"') where workflow_run_id=$1`,
          [runId],
        );
      const event = (
        await api
          .database()
          .query<{ id: string; payload_checksum: string }>(
            "select id,payload_checksum from app.outbox_events where aggregate_id=$1 and job_name='advance-workflow-run'",
            [runId],
          )
      ).rows[0];
      if (event === undefined) throw new Error('Advance delivery missing');
      const failures = createRunFailureStore(config);
      try {
        expect(
          await failures.failUnadvanceable({
            workspaceId,
            runId,
            expectedRevision: 0,
            safeErrorCode: 'execution.run_state_invalid',
            delivery: {
              outboxEventId: event.id,
              payloadChecksum: event.payload_checksum,
            },
            signal: new AbortController().signal,
          }),
        ).toBe('failed');
      } finally {
        await failures.close();
      }
      const get = await api.send('GET', `${base}/runs/${runId}`, { browser });
      expect(get.statusCode, get.payload).toBe(200);
      expect(workflowRunResponseSchema.parse(get.json())).toMatchObject({
        run: {
          id: runId,
          status: 'failed',
          failureReasonCode: 'execution.run_state_invalid',
        },
        nodes: [],
      });
      const list = await api.send('GET', `${base}/runs`, { browser });
      expect(list.statusCode, list.payload).toBe(200);
      expect(workflowRunListResponseSchema.parse(list.json()).items).toEqual([
        expect.objectContaining({
          id: runId,
          failureReasonCode: 'execution.run_state_invalid',
          failedStep: null,
        }),
      ]);
    });
  },
);
