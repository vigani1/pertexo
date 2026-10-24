import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { createWebhookResponseStore } from '../../../src/triggers/webhooks/responses/repository.js';
import { createWebhookTriggerDatabase } from '../../../src/triggers/webhooks/repository.js';
import { NodeAttemptReconciliationRequiredError } from '../../../src/attempts/errors.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { RETENTION_RULES } from '../../../src/lifecycle/retention/rules.js';
import { purgeWorkspace } from '../../support/workspace-purge.js';
import {
  workspaceA,
  workspaceB,
  versionB,
  workflowB,
  asOwner,
  asRuntime,
  asAdmin,
  databaseUrl,
  workerBaseUrl,
  migrationBaseUrl,
  adminBaseUrl,
  insertRun,
  waitForApplicationLocks,
  randomUUID,
} from '../../runs/run-store/fixtures.js';
import { responseFixture, response } from './support.js';
const signal = new AbortController().signal;
const config = parseDatabaseConfig({
  connectionString: databaseUrl(workerBaseUrl),
  max: 4,
});

async function withStore(
  work: (
    store: ReturnType<typeof createWebhookResponseStore>,
    reader: ReturnType<typeof createWebhookTriggerDatabase>,
  ) => Promise<void>,
) {
  const store = createWebhookResponseStore(config);
  const reader = createWebhookTriggerDatabase(config);
  try {
    await work(store, reader);
  } finally {
    await Promise.allSettled([store.close(), reader.close()]);
  }
}
describe('durable webhook responses', () => {
  it('chooses one response across concurrent nodes and recovers the winner receipt', async () => {
    const f = await responseFixture();
    await withStore(async (store, reader) => {
      const results = await Promise.all(
        f.leases.map((lease, i) =>
          store.respond({
            ...lease,
            response: response(`body-${String(i)}`),
            signal,
          }),
        ),
      );
      expect(results.map((r) => r.outcome).sort()).toEqual([
        'already_responded',
        'responded',
      ]);
      const winner = results.findIndex((r) => r.outcome === 'responded');
      const lease = f.leases[winner];
      if (lease === undefined) throw new Error('Response winner missing');
      expect(
        await store.respond({
          ...lease,
          response: response('changed'),
          signal,
        }),
      ).toEqual(results[winner]);
      expect(
        await reader.readResponse({ workspaceId: workspaceA, runId: f.runId }),
      ).toMatchObject({
        state: 'responded',
        response: { body: `body-${String(winner)}`, statusCode: 200 },
      });
      await asOwner(workspaceA, (client) =>
        client.query(
          "update app.workflow_runs set status='failed',completed_at=clock_timestamp() where id=$1",
          [f.runId],
        ),
      );
      expect(
        await reader.readResponse({ workspaceId: workspaceA, runId: f.runId }),
      ).toMatchObject({ state: 'responded' });
    });
  });
  it('never creates a reply correlation while executing a run without one', async () => {
    const f = await responseFixture(1, false);
    await withStore(async (store, reader) => {
      expect(
        await store.respond({ ...f.first, response: response(), signal }),
      ).toEqual({ outcome: 'not_waiting', statusCode: null });
      expect(
        await reader.readResponse({ workspaceId: workspaceA, runId: f.runId }),
      ).toEqual({ state: 'finished' });
      expect(
        (
          await asRuntime(workerBaseUrl, workspaceA, (client) =>
            client.query(
              'select run_id from app.webhook_run_responses where run_id=$1',
              [f.runId],
            ),
          )
        ).rows,
      ).toEqual([]);
    });
  });
  it('refuses stale owners/fences, missing dispatch and a canceled run without storing bytes', async () => {
    const f = await responseFixture(1);
    await withStore(async (store, reader) => {
      for (const changed of [
        { workerId: 'wrong-worker' },
        { fenceToken: f.first.fenceToken + 1 },
        { workspaceId: workspaceB },
      ])
        await expect(
          store.respond({
            ...f.first,
            ...changed,
            response: response(),
            signal,
          }),
        ).rejects.toBeInstanceOf(NodeAttemptReconciliationRequiredError);
      await asOwner(workspaceA, (client) =>
        client.query(
          'update app.node_attempts set dispatch_marked_at=null where id=$1',
          [f.first.attemptId],
        ),
      );
      await expect(
        store.respond({ ...f.first, response: response(), signal }),
      ).rejects.toBeInstanceOf(NodeAttemptReconciliationRequiredError);
      await asOwner(workspaceA, async (client) => {
        await client.query(
          'update app.node_attempts set dispatch_marked_at=clock_timestamp() where id=$1',
          [f.first.attemptId],
        );
        await client.query(
          "update app.workflow_runs set cancel_requested_at=clock_timestamp(),cancel_requested_by='fixture' where id=$1",
          [f.runId],
        );
      });
      await expect(
        store.respond({ ...f.first, response: response(), signal }),
      ).rejects.toBeInstanceOf(NodeAttemptReconciliationRequiredError);
      expect(
        await reader.readResponse({ workspaceId: workspaceA, runId: f.runId }),
      ).toEqual({ state: 'pending' });
    });
  });
  it('checks lease expiry after an unchanged response-row lock wait', async () => {
    const f = await responseFixture(1);
    const name = `response-expiry-${randomUUID()}`;
    const url = new URL(databaseUrl(workerBaseUrl));
    url.searchParams.set('application_name', name);
    const store = createWebhookResponseStore(
      parseDatabaseConfig({ connectionString: url.toString(), max: 1 }),
    );
    const blockerPool = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    const blocker = await blockerPool.connect();
    let write: Promise<unknown> | undefined;
    try {
      await asOwner(workspaceA, (client) =>
        client.query(
          "update app.node_attempts set lease_expires_at=clock_timestamp()+interval '500 milliseconds' where id=$1",
          [f.first.attemptId],
        ),
      );
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await blocker.query(
        'select run_id from app.webhook_run_responses where run_id=$1 for update',
        [f.runId],
      );
      write = store.respond({ ...f.first, response: response(), signal });
      void write.catch(() => undefined);
      await waitForApplicationLocks(name, 1);
      await blocker.query(
        'select pg_sleep(greatest(0,extract(epoch from (lease_expires_at-clock_timestamp())))+0.01) from app.node_attempts where id=$1',
        [f.first.attemptId],
      );
      await blocker.query('commit');
      await expect(write).rejects.toBeInstanceOf(
        NodeAttemptReconciliationRequiredError,
      );
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await Promise.allSettled(write === undefined ? [] : [write]);
      await store.close();
      await blockerPool.end();
    }
    expect(
      (
        await asOwner(workspaceA, (client) =>
          client.query(
            'select body from app.webhook_run_responses where run_id=$1',
            [f.runId],
          ),
        )
      ).rows,
    ).toEqual([{ body: null }]);
  });
  it('fences workspace reads and hides expired data before maintenance removes it', async () => {
    const f = await responseFixture(1);
    await withStore(async (store, reader) => {
      await store.respond({ ...f.first, response: response(), signal });
      expect(
        await reader.readResponse({ workspaceId: workspaceB, runId: f.runId }),
      ).toEqual({ state: 'finished' });
      const unscoped = new Pool({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
      });
      try {
        expect(
          (await unscoped.query('select * from app.webhook_run_responses'))
            .rows,
        ).toEqual([]);
      } finally {
        await unscoped.end();
      }
      await asOwner(workspaceA, (client) =>
        client.query(
          "update app.workflow_runs set created_at=clock_timestamp()-interval '33 days',started_at=clock_timestamp()-interval '32 days',completed_at=clock_timestamp()-interval '31 days',status='succeeded' where id=$1",
          [f.runId],
        ),
      );
      expect(
        await reader.readResponse({ workspaceId: workspaceA, runId: f.runId }),
      ).toEqual({ state: 'finished' });
      const rule = RETENTION_RULES.find((r) => r.name === 'webhook_responses');
      if (rule === undefined) throw new Error('Response retention missing');
      await asAdmin(async (pool) => {
        const client = await pool.connect();
        try {
          await client.query('set role pertexo_maintenance');
          await rule.run(client, 100);
        } finally {
          client.release();
        }
      });
      expect(
        (
          await asOwner(workspaceA, (client) =>
            client.query(
              'select run_id from app.webhook_run_responses where run_id=$1',
              [f.runId],
            ),
          )
        ).rows,
      ).toEqual([]);
    });
  });
  it('purges response correlations before deleting workspace runs', async () => {
    const runId = await insertRun({
      workspaceId: workspaceB,
      workflowId: workflowB,
      workflowVersionId: versionB,
      triggerType: 'webhook',
    });
    await asOwner(workspaceB, (client) =>
      client.query(
        'insert into app.webhook_run_responses(workspace_id,run_id,wait_seconds) values($1,$2,10)',
        [workspaceB, runId],
      ),
    );
    const maintenanceUrl = databaseUrl(
      process.env.DATABASE_MAINTENANCE_URL ??
        'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
    );
    await purgeWorkspace({
      workspaceId: workspaceB,
      adminUrl: databaseUrl(adminBaseUrl),
      maintenanceUrl,
      pageSize: 100,
    });
    expect(
      (
        await asAdmin((client) =>
          client.query(
            'select run_id from app.webhook_run_responses where workspace_id=$1',
            [workspaceB],
          ),
        )
      ).rows,
    ).toEqual([]);
  });
});
