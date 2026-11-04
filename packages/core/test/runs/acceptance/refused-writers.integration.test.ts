import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { acceptWorkflowRun } from '../../../src/runs/commands/acceptance/accept.js';
import { WorkspaceRunAdmissionDeniedError } from '../../../src/runs/commands/acceptance/run-admission.errors.js';
import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  installExecutionAcceptanceFixture,
  hasPostgresCode,
  lockManualFixtureStart,
  migrationUrl,
  workspaceA,
  waitForDatabaseLock,
} from './run-acceptance.fixture.js';

installExecutionAcceptanceFixture();

const writers = [
  'api',
  'manual',
  'replay',
  'schedule',
  'webhook',
  'workflow_call',
  'workflow_error',
  'form',
  'test',
] as const;

describe('refused requests leave no admitted work through any writer', () => {
  it.each(writers)(
    'refuses an already canceled %s request without charging capacity',
    async (triggerType) => {
      const input = await writerInput(triggerType);
      const reason = new Error('Caller canceled admission');
      await expect(
        apiDatabase.withWorkspace(
          workspaceA,
          (tx) => acceptWorkflowRun(tx, input),
          { signal: AbortSignal.abort(reason) },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await expectEmptyAdmission(triggerType);
    },
  );

  it.each(writers)(
    'rolls back a %s request canceled during the capacity lock wait',
    async (triggerType) => {
      const input = await writerInput(triggerType);
      const pool = new Pool({ connectionString: migrationUrl, max: 1 });
      const holder = await pool.connect();
      const controller = new AbortController();
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query('begin');
        await holder.query('set local role pertexo_owner');
        await holder.query("select set_config('app.workspace_id',$1,true)", [
          workspaceA,
        ]);
        const locked = await holder.query<{ pid: number }>(
          'select pg_backend_pid() pid from app.workspace_execution_admission_counters where workspace_id=$1 for update',
          [workspaceA],
        );
        const pid = locked.rows[0]?.pid;
        if (pid === undefined) throw new Error('Missing capacity counter');
        pending = apiDatabase.withWorkspace(
          workspaceA,
          async (tx) => {
            if (triggerType === 'manual') await lockManualFixtureStart(tx);
            return acceptWorkflowRun(tx, input);
          },
          { signal: controller.signal },
        );
        const observed = pending.catch((error: unknown) => error);
        await waitForDatabaseLock(pid);
        controller.abort();
        await holder.query('rollback');
        expect(await observed).toMatchObject({ name: 'AbortError' });
        await expectEmptyAdmission(triggerType);
      } finally {
        controller.abort();
        await holder.query('rollback');
        await pending?.catch(() => undefined);
        holder.release();
        await pool.end();
      }
    },
  );

  for (const status of ['suspended', 'pending_deletion', 'deleted'] as const) {
    it.each(writers)(
      `refuses %s in a ${status} workspace without charging capacity`,
      async (triggerType) => {
        const input = await writerInput(triggerType);
        await ownerQuery(
          `update app.workspaces set status=$2::text,
            deletion_requested_at=case when $2::text='suspended' then null else clock_timestamp() end,
            deletion_requested_by=case when $2::text in ('suspended','deleted') then null else created_by end,
            created_by=case when $2::text='deleted' then null else created_by end,
            name=case when $2::text='deleted' then 'Deleted workspace' else name end,
            slug=case when $2::text='deleted' then 'deleted-'||id::text else slug end,
            deletion_reason=case when $2::text='suspended' then null when $2::text='deleted' then 'purged' else 'Closing workspace' end,
            purge_after=case when $2::text='suspended' then null else clock_timestamp()+interval '30 days' end
          where id=$1`,
          [workspaceA, status],
        );
        await expect(
          apiDatabase.withWorkspace(workspaceA, async (tx) => {
            if (triggerType === 'manual') await lockManualFixtureStart(tx);
            return acceptWorkflowRun(tx, input);
          }),
        ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
        await expectEmptyAdmission(triggerType);
      },
    );
  }

  it.each(writers)(
    'refuses an expired %s deadline without charging capacity',
    async (triggerType) => {
      const input = await writerInput(triggerType);
      await expect(
        apiDatabase.withWorkspace(workspaceA, async (tx) => {
          if (triggerType === 'manual') await lockManualFixtureStart(tx);
          return acceptWorkflowRun(tx, {
            ...input,
            deadlineAt: new Date('2000-01-01T00:00:00Z'),
          });
        }),
      ).rejects.toSatisfy(hasPostgresCode('23514'));
      await expectEmptyAdmission(triggerType);
    },
  );
});

async function writerInput(triggerType: (typeof writers)[number]) {
  if (triggerType !== 'replay') return { ...acceptanceInput(), triggerType };
  const source = await apiDatabase.withWorkspace(workspaceA, (tx) =>
    acceptWorkflowRun(tx, acceptanceInput()),
  );
  await ownerQuery(
    "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp() where id=$1",
    [source.runId],
  );
  return {
    ...acceptanceInput(),
    triggerType,
    scope: 'refused:replay',
    replayCommandId: randomUUID(),
    replaySourceRunId: source.runId,
  };
}

async function expectEmptyAdmission(triggerType: (typeof writers)[number]) {
  await expectAcceptanceRecordCounts(triggerType === 'replay' ? 1 : 0);
  const rows = await ownerQuery(
    'select active_runs,queued_runs from app.workspace_execution_admission_counters where workspace_id=$1',
    [workspaceA],
  );
  expect(rows).toEqual([{ active_runs: 0, queued_runs: 0 }]);
}

async function ownerQuery(statement: string, values: readonly unknown[]) {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    const result = await client.query<Record<string, unknown>>(statement, [
      ...values,
    ]);
    await client.query('commit');
    return result.rows;
  } finally {
    await client.query('rollback');
    client.release();
    await pool.end();
  }
}
