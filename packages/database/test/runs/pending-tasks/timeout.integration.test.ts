import { describe, expect, it } from 'vitest';
import { pendingTaskDetailSchema } from '@pertexo/contracts';
import { timedOutTaskOutputSchema } from '@pertexo/workflow-model';
import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';
import { readPendingTaskFacts } from '../../../src/runs/pending-tasks/lifecycle/facts.queries.js';
import { admin, pool, store, taskFixture } from './fixtures.js';

type Fixture = Awaited<ReturnType<typeof taskFixture>>;

async function passDue(f: Fixture) {
  await admin.query(
    `update app.pending_run_tasks set created_at=clock_timestamp()-interval '7 days 1 minute',expires_at=clock_timestamp()-interval '1 minute',context='{"details":{"Customer":"Ada"}}'::jsonb where id=$1`,
    [f.taskId],
  );
}

function sweep(f: Fixture) {
  return withTenantScopedClient(
    pool,
    { workspaceId: f.workspaceId },
    (client) => readPendingTaskFacts(client, f.workspaceId, f.parentRunId),
  );
}

async function storedTask(f: Fixture) {
  const result = await admin.query<{
    status: string;
    output_ref: { kind: string; value: unknown } | null;
    created_at: Date;
    expires_at: Date;
    completed_at: Date | null;
  }>(
    'select status,output_ref,created_at,expires_at,completed_at from app.pending_run_tasks where id=$1',
    [f.taskId],
  );
  const [row] = result.rows;
  if (row === undefined) throw new Error('Task missing');
  return row;
}

describe('expiry of a task that continues on Timed out', () => {
  it('records the timed-out output when the sweep expires it', async () => {
    const f = await taskFixture({ onExpiry: 'continue' });
    await passDue(f);
    expect(await sweep(f)).toMatchObject([
      { taskId: f.taskId, status: 'expired' },
    ]);
    const row = await storedTask(f);
    expect(row.status).toBe('expired');
    expect(row.output_ref?.kind).toBe('inline');
    expect(timedOutTaskOutputSchema.parse(row.output_ref?.value)).toEqual({
      timedOut: true,
      openedAt: row.created_at.toISOString(),
      expiredAt: row.expires_at.toISOString(),
      audience: { roles: ['owner', 'admin'], memberIds: [] },
      details: { Customer: 'Ada' },
    });
  });

  it('settles once: a second sweep after a restart changes nothing', async () => {
    const f = await taskFixture({ onExpiry: 'continue' });
    await passDue(f);
    await sweep(f);
    const first = await storedTask(f);
    expect(await sweep(f)).toMatchObject([
      { taskId: f.taskId, status: 'expired' },
    ]);
    expect(await storedTask(f)).toEqual(first);
  });

  it('refuses a late decision and shows the request without an answer', async () => {
    const f = await taskFixture({ onExpiry: 'continue' });
    await passDue(f);
    await sweep(f);
    await expect(
      store.decide({
        ...f.scope,
        decision: 'approved',
        idempotencyKey: 'late',
      }),
    ).rejects.toMatchObject({ reason: 'expired' });
    const detail = pendingTaskDetailSchema.parse(await store.read(f.scope));
    expect(detail).toMatchObject({
      status: 'expired',
      onExpiry: 'continue',
      output: null,
      canRespond: false,
      blockedReason: 'expired',
    });
    expect((await storedTask(f)).status).toBe('expired');
  });

  it('keeps a failing task without an output', async () => {
    const f = await taskFixture();
    await passDue(f);
    await sweep(f);
    const row = await storedTask(f);
    expect(row).toMatchObject({ status: 'expired', output_ref: null });
    expect(
      pendingTaskDetailSchema.parse(await store.read(f.scope)).onExpiry,
    ).toBe('fail');
  });

  it('never stores an output on a task that closed for another reason', async () => {
    const f = await taskFixture({ onExpiry: 'continue' });
    await expect(
      admin.query(
        `update app.pending_run_tasks set status='refused',completed_at=clock_timestamp(),output_ref='{"kind":"inline","value":{}}'::json where id=$1`,
        [f.taskId],
      ),
    ).rejects.toThrow(/pending_run_tasks_state_valid/u);
  });
});
