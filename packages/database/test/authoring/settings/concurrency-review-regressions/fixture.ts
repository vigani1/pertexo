import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { expect } from 'vitest';

import type { LeasedOutboxEvent } from '../../../../src/outbox/dispatcher/contract.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../../../../src/outbox/events.repository.js';
import {
  apiDatabase,
  migrationUrl,
  workflowId,
  workflowVersionId,
  workspaceA,
  workspaceCreatorId,
} from '../../../runs/acceptance/fixtures.js';
import type { acceptRun } from '../concurrency-admission.fixtures.js';
import { withOwner } from '../concurrency-admission.fixtures.js';

export function workerUrl() {
  const url = new URL(process.env.DATABASE_URL ?? migrationUrl);
  if (process.env.DATABASE_URL === undefined) {
    url.username = 'pertexo_app';
    url.password = 'pertexo-local-app';
  }
  url.pathname = new URL(migrationUrl).pathname;
  return url.toString();
}

export const insertionCases = (['API', 'worker'] as const).flatMap((role) =>
  (['running', 'waiting'] as const).flatMap((status) =>
    [false, true].map((protocol) => ({ role, status, protocol })),
  ),
);

/** Advancing a run reads its published version, so one must exist. */
export async function publishExecutableVersion(): Promise<void> {
  await withOwner(async (client) => {
    await client.query(
      'alter table app.workflow_versions no force row level security',
    );
    await client.query(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,graph_json,
         checksum,executable_json,published_by
       ) values ($1,$2,$3,1,'{}'::jsonb,$4,$5::jsonb,$6)
       on conflict (id) do nothing`,
      [
        workflowVersionId,
        workspaceA,
        workflowId,
        `wf:sha256:${'c'.repeat(64)}`,
        JSON.stringify({ graph: { nodes: [], edges: [] } }),
        workspaceCreatorId,
      ],
    );
    await client.query(
      'alter table app.workflow_versions force row level security',
    );
  });
}

export function startInput(
  event: LeasedOutboxEvent,
  initial: Awaited<
    ReturnType<typeof acceptRun>
  >['request']['initialCheckpoint'],
) {
  return {
    workspaceId: workspaceA,
    runId: event.aggregateId,
    workflowVersionId,
    delivery: {
      outboxEventId: event.id,
      payloadChecksum: event.payloadChecksum,
    },
    signal: new AbortController().signal,
    plan: {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: {
        ...initial,
        revision: 1,
        runStatus: 'running' as const,
        nextEventSequence: 3,
      },
      events: [
        {
          sequence: 2,
          name: 'run.started' as const,
          occurredAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    },
  };
}

export function reservations() {
  return withOwner(
    async (client) =>
      (
        await client.query<{
          workflow_run_id: string;
          outbox_event_id: string;
          created_at: Date;
          recovery_count: number;
          workflow_concurrency_order_exempt: boolean;
        }>(`select workflow_run_id,outbox_event_id,created_at,recovery_count::integer recovery_count,workflow_concurrency_order_exempt
      from app.workflow_run_active_admissions order by workflow_run_id`)
      ).rows,
  );
}

export async function deferredDelivery(runId: string, originalEventId: string) {
  const events = await withOwner(
    async (client) =>
      (
        await client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events where aggregate_id=$1 and id<>$2
      and job_name='advance-workflow-run' order by created_at`,
          [runId, originalEventId],
        )
      ).rows,
  );
  expect(events).toHaveLength(1);
  const event = events[0];
  if (event === undefined)
    throw new Error('Missing deferred transport identity');
  return event;
}

export async function withWorker<T>(
  operation: (client: PoolClient) => Promise<T>,
) {
  const pool = new Pool({ connectionString: workerUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function pendingDelivery(runId: string, payloadRunId = runId) {
  const id = randomUUID();
  const payload = {
    workspaceId: workspaceA,
    outboxEventId: id,
    runId: payloadRunId,
  };
  await apiDatabase.withWorkspace(workspaceA, (transaction) =>
    insertOutboxEvent(transaction, {
      id,
      jobName: 'advance-workflow-run',
      aggregateType: 'workflow-run',
      aggregateId: runId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      availableAt: new Date(),
    }),
  );
  return id;
}

export function rebind(runId: string, oldId: string, newId: string) {
  return withWorker(
    async (client) =>
      (
        await client.query<{ rebound: boolean }>(
          'select app.rebind_workflow_run_active_admission($1,$2,$3,$4) rebound',
          [workspaceA, runId, oldId, newId],
        )
      ).rows[0]?.rebound,
  );
}
