import { maintenanceConfig } from '../../../../infrastructure/testing/worker-databases.mjs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database/platform';
import {
  createScheduleTriggerScanner,
  createScheduleTriggerStore,
  createWorkflowTriggerReconciliationStore,
} from '@pertexo/core/triggers';
import { initialCheckpointFactory } from '@pertexo/core/runs';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import { scheduleTriggerListResponseSchema } from '@pertexo/contracts';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { apiBaseUrl } from '../support/better-auth/api/environment.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'schedule repair health over HTTP',
  () => {
    let config: DatabaseConfig | undefined;
    const api = useBetterAuthRealApi('schedule_repair', {
      schedules: true,
      afterMigration: (url) => {
        config = parseDatabaseConfig({ connectionString: url(apiBaseUrl) });
        return Promise.resolve();
      },
    });
    it('keeps scanner-classified malformed recurrence and the other schedule readable', async () => {
      if (config === undefined) throw new Error('Database fixture is missing');
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const browser = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Schedule repair', slug: `repair-${randomUUID()}` },
      });
      expect(workspace.statusCode).toBe(201);
      const workspaceId = workspace.json<{ id: string }>().id;
      const actor = (
        await api
          .database()
          .query<{ id: string }>('select id from app.users where email=$1', [
            email,
          ])
      ).rows[0];
      if (actor === undefined) throw new Error('Actor is missing');
      const base = `/v1/workspaces/${workspaceId}/workflows`;
      const created = await api.send('POST', base, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Repairable schedules' },
      });
      expect(created.statusCode).toBe(201);
      const workflowId = created.json<{ workflow: { id: string } }>().workflow
        .id;
      const path = `${base}/${workflowId}`;
      const saved = await api.send('PUT', `${path}/draft`, {
        browser,
        headers: { 'if-match': String(created.headers.etag) },
        payload: {
          graph: {
            settings: {},
            edges: [],
            nodes: ['broken', 'healthy'].map((id) => ({
              id,
              definition: { key: 'core.schedule', version: 1 },
              configVersion: 1,
              config: {
                kind: 'interval',
                intervalMinutes: 60,
                misfirePolicy: 'skip',
              },
              inputMappings: {},
              connectionRefs: {},
              position: { x: 0, y: 0 },
            })),
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
      const versionId = published.json<{ version: { id: string } }>().version
        .id;
      const event = (
        await api
          .database()
          .query<{ id: string }>(
            "select id from app.outbox_events where aggregate_id=$1 and job_name='reconcile-workflow-triggers'",
            [workflowId],
          )
      ).rows[0];
      if (event === undefined) throw new Error('Publication event is missing');
      const reconciliation = createWorkflowTriggerReconciliationStore(config);
      const schedules = createScheduleTriggerStore(config);
      const scanner = createScheduleTriggerScanner(
        maintenanceConfig(config),
        config,
      );
      try {
        const triggers = await reconciliation.reconcile({
          workspaceId,
          workflowId,
          publishedVersionId: versionId,
          outboxEventId: event.id,
        });
        const broken = triggers.find((row) => row.nodeId === 'broken');
        if (broken === undefined)
          throw new Error('Published schedule is missing');
        await api
          .database()
          .query(
            `update app.trigger_schedules set recurrence_kind='cron',cron_expression='private malformed recurrence',timezone='Europe/London',interval_minutes=null,next_fire_at=clock_timestamp()-interval '1 minute' where trigger_id=$1`,
            [broken.id],
          );
        await expect(
          scanner.scanDue({
            leaseOwner: 'repair-http',
            limit: 10,
            leaseSeconds: 30,
            onTimeWindowSeconds: 300,
            checkpointFactory: initialCheckpointFactory({
              catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
            }),
          }),
        ).rejects.toThrow('Invalid schedule recurrence');
        const rows = await schedules.list({
          workspaceId,
          workflowId,
          actorId: actor.id,
        });
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.id === broken.id)).toMatchObject({
          recurrence: null,
          lastErrorCode: 'schedule.recurrence_invalid',
          healthStatus: 'unhealthy',
        });
        const response = await api.send('GET', `${path}/triggers/schedules`, {
          browser,
        });
        expect(response.statusCode, response.payload).toBe(200);
        const health = scheduleTriggerListResponseSchema.parse(response.json());
        expect(health.items).toHaveLength(2);
        expect(health.items.find((row) => row.id === broken.id)).toMatchObject({
          recurrence: null,
          lastErrorCode: 'schedule.recurrence_invalid',
          healthStatus: 'unhealthy',
        });
        expect(response.payload).not.toContain('private malformed recurrence');
      } finally {
        await Promise.all([
          reconciliation.close(),
          schedules.close(),
          scanner.close(),
        ]);
      }
    });
  },
);
