import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { acceptWorkflowRun } from '../src/execution/execution-acceptance.js';
import { ExecutionStateConflictError } from '../src/execution/execution-state.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  appendRunEvent,
  readRunEventsAfter,
} from '../src/execution/run-events.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const worker = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
);
const workspaceId = randomUUID();
const workspaceCreatorId = randomUUID();

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

async function resetFixture(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query('begin');
    await pool.query('set local role pertexo_owner');
    await pool.query(`
      truncate table app.operator_commands, app.audit_events,
        app.node_attempts, app.node_runs, app.idempotency_records,
        app.run_events, app.run_checkpoints, app.workflow_runs,
        app.outbox_events cascade
    `);
    await pool.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Run event fixture owner', 'active')
       on conflict (id) do update set status='active'`,
      [workspaceCreatorId, `run-event-${workspaceCreatorId}@example.test`],
    );
    await pool.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
       values ($1, 'Run events', $2, 'active', $3)
       on conflict (id) do update set status='active'`,
      [workspaceId, `run-events-${workspaceId}`, workspaceCreatorId],
    );
    await pool.query('commit');
  } catch (error: unknown) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

async function acceptRun(): Promise<string> {
  return worker.withWorkspace(workspaceId, async (transaction) => {
    const workflowVersionId = randomUUID();
    const accepted = await acceptWorkflowRun(transaction, {
      engineVersion: 'run-events-v1',
      initialCheckpoint: {
        schemaVersion: 1,
        engineVersion: 'run-events-v1',
        workflowVersionId,
        revision: 0,
        runStatus: 'queued',
        nextEventSequence: 2,
        readySet: [],
        admittedInvocationKeys: [],
        invocations: [],
        joins: [],
        loops: [],
        remainingIterationBudget: 0,
        cancelRequested: false,
        deadlineExpired: false,
      },
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `manual:${randomUUID()}`,
      triggerType: 'manual',
      workflowId: randomUUID(),
      workflowVersionId,
    });
    return accepted.runId;
  });
}

beforeAll(() => migrateDatabase(migrationConfig));
beforeEach(resetFixture);
afterAll(() => worker.close());

describe('run event persistence', () => {
  it('appends bounded versioned events and reads a gapless page', async () => {
    const runId = await acceptRun();
    await expect(
      worker.withWorkspace(workspaceId, (transaction) =>
        appendRunEvent(transaction, {
          event: { payload: { progress: 25 }, type: 'node.progress' },
          runId,
        }),
      ),
    ).resolves.toBe(2);

    const page = await worker.withWorkspace(workspaceId, (transaction) =>
      readRunEventsAfter(transaction, {
        afterSequence: 1,
        limit: 10,
        runId,
      }),
    );
    expect(page).toMatchObject({
      events: [
        {
          payload: { progress: 25, schemaVersion: 1 },
          sequence: 2,
          type: 'node.progress',
        },
      ],
      hasMore: false,
      highWaterSequence: 2,
    });
  });

  it('fails closed when durable event history contains a sequence gap', async () => {
    const runId = await acceptRun();
    await worker.withWorkspace(workspaceId, ({ db }) =>
      db.execute(sql`
        insert into app.run_events
          (workspace_id, workflow_run_id, sequence, type, payload)
        values (${workspaceId}, ${runId}, 3, 'node.progress',
          '{"schemaVersion":1,"progress":50}'::jsonb)
      `),
    );
    await expect(
      worker.withWorkspace(workspaceId, (transaction) =>
        readRunEventsAfter(transaction, {
          afterSequence: 1,
          limit: 10,
          runId,
        }),
      ),
    ).rejects.toThrow('execution.run_event_gap');
  });

  it('rejects accessors and proxies without invoking application hooks', async () => {
    const runId = await acceptRun();
    let getterCalls = 0;
    const accessorPayload: Record<string, unknown> = {};
    Object.defineProperty(accessorPayload, 'progress', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 25;
      },
    });
    let proxyTrapCalls = 0;
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          proxyTrapCalls += 1;
          return [];
        },
      },
    );

    for (const payload of [
      accessorPayload,
      hostileProxy,
      { nested: hostileProxy },
    ])
      await expect(
        worker.withWorkspace(workspaceId, (transaction) =>
          appendRunEvent(transaction, {
            event: { payload, type: 'node.progress' },
            runId,
          }),
        ),
      ).rejects.toBeInstanceOf(ExecutionStateConflictError);
    expect(getterCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
  });

  it('enforces the event limit after adding the schema version', async () => {
    const runId = await acceptRun();
    const envelopeBytes = Buffer.byteLength(
      '{"data":"","schemaVersion":1}',
      'utf8',
    );
    const exactData = 'x'.repeat(4096 - envelopeBytes);
    await expect(
      worker.withWorkspace(workspaceId, (transaction) =>
        appendRunEvent(transaction, {
          event: { payload: { data: exactData }, type: 'node.progress' },
          runId,
        }),
      ),
    ).resolves.toBe(2);
    await expect(
      worker.withWorkspace(workspaceId, (transaction) =>
        appendRunEvent(transaction, {
          event: { payload: { data: `${exactData}x` }, type: 'node.progress' },
          runId,
        }),
      ),
    ).rejects.toThrow('JSON value must not exceed 4096 UTF-8 bytes');
  });
});
