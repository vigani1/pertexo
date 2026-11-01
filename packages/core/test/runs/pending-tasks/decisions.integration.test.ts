import {
  waitForPostgresLock,
  apiUrl,
} from '../../lifecycle/retention.support.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { readPendingTaskFacts } from '../../../src/runs/pending-tasks/lifecycle/facts.queries.js';
import { describe, it, expect } from 'vitest';
import { pendingTaskDetailSchema } from '@pertexo/contracts';
import { WorkspaceAccessDeniedError } from '../../../src/tenant-access/errors.js';
import { createPendingTaskStore } from '../../../src/runs/pending-tasks/responses/repository.js';
import {
  PendingTaskDecisionError,
  PendingTaskNotFoundError,
} from '../../../src/runs/pending-tasks/responses/errors.js';
import { admin, store, taskFixture, userId, pool } from './fixtures.js';

describe('current authority and atomic human decisions', () => {
  it('admits a named viewer without granting the team directory; refuses the starter', async () => {
    const f = await taskFixture({ named: true });
    expect(
      pendingTaskDetailSchema.parse(await store.read(f.scope)),
    ).toMatchObject({ canRespond: true, status: 'pending', iterationPath: [] });
    const mine = await store.list({
      ...f.scope,
      view: 'mine',
      status: 'pending',
    });
    expect(mine.items.map((item) => item.id)).toEqual([f.taskId]);
    expect(mine.pendingCount).toBe(1);
    await expect(
      store.decide({
        ...f.scope,
        actorId: userId,
        decision: 'approved',
        idempotencyKey: 'starter',
      }),
    ).rejects.toMatchObject({ reason: 'starter' });
    await expect(store.audience({ ...f.scope, q: '' })).rejects.toBeInstanceOf(
      WorkspaceAccessDeniedError,
    );
    const result = await store.decide({
      ...f.scope,
      decision: 'approved',
      comment: 'Looks good',
      idempotencyKey: 'viewer',
    });
    expect(result.task.output).toMatchObject({
      decision: 'approved',
      comment: 'Looks good',
      decidedBy: f.deciderId,
      decidedByName: 'Approver',
    });
  });
  it('has one winner under concurrent approve/reject and emits one audit and wake', async () => {
    const f = await taskFixture();
    const results = await Promise.allSettled(
      ['approved', 'rejected'].map((decision) =>
        store.decide({
          ...f.scope,
          decision: decision as 'approved' | 'rejected',
          idempotencyKey: decision,
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toMatchObject([{ reason: { reason: 'resolved' } }]);
    const audit = await admin.query(
      'select metadata from app.audit_events where workspace_id=$1 and target_id=$2',
      [f.workspaceId, f.taskId],
    );
    expect(audit.rows).toHaveLength(1);
    const wake = await admin.query(
      "select id from app.outbox_events where workspace_id=$1 and aggregate_id=$2 and job_name='advance-workflow-run'",
      [f.workspaceId, f.parentRunId],
    );
    expect(wake.rows).toHaveLength(1);
  });
  it('replays the same command after a lost response without recording or waking twice', async () => {
    const f = await taskFixture();
    const request = {
      ...f.scope,
      decision: 'rejected' as const,
      comment: 'Please revise',
      idempotencyKey: 'same',
    };
    const first = await store.decide(request);
    const second = await store.decide(request);
    expect(second).toEqual({ ...first, replayed: true });
    const count = await admin.query(
      'select count(*)::int n from app.audit_events where workspace_id=$1 and target_id=$2',
      [f.workspaceId, f.taskId],
    );
    expect(count.rows[0]).toEqual({ n: 1 });
  });
  it.each(['role', 'removed', 'inactive'] as const)(
    'rechecks %s loss before deciding',
    async (change) => {
      const f = await taskFixture();
      expect((await store.read(f.scope)).canRespond).toBe(true);
      if (change === 'role')
        await admin.query(
          "update app.workspace_memberships set role='viewer',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
          [f.workspaceId, f.deciderId],
        );
      if (change === 'removed')
        await admin.query(
          "update app.workspace_memberships set status='removed',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
          [f.workspaceId, f.deciderId],
        );
      if (change === 'inactive')
        await admin.query(
          "update app.users set status='suspended' where id=$1",
          [f.deciderId],
        );
      await expect(
        store.decide({
          ...f.scope,
          decision: 'approved',
          idempotencyKey: 'revoked',
        }),
      ).rejects.toBeInstanceOf(
        change === 'role'
          ? PendingTaskDecisionError
          : WorkspaceAccessDeniedError,
      );
      expect(
        (
          await admin.query(
            'select status from app.pending_run_tasks where id=$1',
            [f.taskId],
          )
        ).rows[0],
      ).toEqual({ status: 'pending' });
    },
  );
  it.each(['expiry', 'cancel', 'deadline'] as const)(
    'refuses %s before resolving',
    async (change) => {
      const f = await taskFixture();
      if (change === 'expiry')
        await admin.query(
          "update app.pending_run_tasks set created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where id=$1",
          [f.taskId],
        );
      if (change === 'cancel')
        await admin.query(
          "update app.workflow_runs set cancel_requested_at=clock_timestamp(),cancel_requested_by=started_by,cancel_reason='Requested by member' where id=$1",
          [f.parentRunId],
        );
      if (change === 'deadline')
        await admin.query(
          "update app.workflow_runs set deadline_at=clock_timestamp()-interval '1 second' where id=$1",
          [f.parentRunId],
        );
      await expect(
        store.decide({
          ...f.scope,
          decision: 'approved',
          idempotencyKey: 'closed',
        }),
      ).rejects.toMatchObject({
        reason: change === 'expiry' ? 'expired' : 'run_closed',
      });
    },
  );
  it('cannot read or decide a task through a different workspace', async () => {
    const f = await taskFixture();
    const other = await taskFixture();
    const scope = {
      ...f.scope,
      workspaceId: other.workspaceId,
      actorId: other.deciderId,
    };
    await expect(store.read(scope)).rejects.toBeInstanceOf(
      PendingTaskNotFoundError,
    );
    await expect(
      store.decide({
        ...scope,
        decision: 'approved',
        idempotencyKey: 'foreign',
      }),
    ).rejects.toBeInstanceOf(PendingTaskNotFoundError);
  });
});

it('refuses a decision released from a task lock after expiry and records one expiry fact', async () => {
  const f = await taskFixture();
  const name = `task-expiry-${crypto.randomUUID()}`;
  const url = new URL(apiUrl);
  url.searchParams.set('application_name', name);
  const contender = createPendingTaskStore(
    parseDatabaseConfig({ connectionString: url.toString(), max: 1 }),
  );
  await admin.query('begin');
  let locked = true;
  let decision: Promise<unknown> | undefined;
  try {
    await admin.query(
      "update app.pending_run_tasks set created_at=clock_timestamp()-interval '7 days'+interval '1 second',expires_at=clock_timestamp()+interval '1 second' where id=$1",
      [f.taskId],
    );
    decision = contender.decide({
      ...f.scope,
      decision: 'approved',
      idempotencyKey: 'expiry-race',
    });
    // Attach the rejection handler before the lock is released.
    const refused = expect(decision).rejects.toMatchObject({
      reason: 'expired',
    });
    await waitForPostgresLock(name);
    await admin.query(
      'select pg_sleep(greatest(0,extract(epoch from expires_at-clock_timestamp()))+0.02) from app.pending_run_tasks where id=$1',
      [f.taskId],
    );
    await admin.query('commit');
    locked = false;
    await refused;
    const facts = await withTenantScopedClient(
      pool,
      { workspaceId: f.workspaceId },
      (client) => readPendingTaskFacts(client, f.workspaceId, f.parentRunId),
    );
    expect(facts).toMatchObject([{ taskId: f.taskId, status: 'expired' }]);
    const audit = await admin.query(
      'select id from app.audit_events where target_id=$1',
      [f.taskId],
    );
    expect(audit.rows).toEqual([]);
  } finally {
    if (locked) await admin.query('rollback');
    await decision?.catch(() => undefined);
    await contender.close();
  }
});

it('allows the starter only by captured opt-in and still enforces the audience', async () => {
  for (const allowed of [undefined, false, true]) {
    const f = await taskFixture(
      allowed === undefined ? {} : { allowStarterToDecide: allowed },
    );
    const command = {
      ...f.scope,
      actorId: userId,
      decision: 'approved' as const,
      idempotencyKey: 'starter-choice',
    };
    if (allowed === true) {
      expect((await store.read(command)).canRespond).toBe(true);
      expect(
        (
          await store.list({ ...command, view: 'mine', status: 'pending' })
        ).items.map((item) => item.id),
      ).toContain(f.taskId);
      expect((await store.decide(command)).task.status).toBe('approved');
    } else {
      expect((await store.read(command)).blockedReason).toBe('starter');
      await expect(store.decide(command)).rejects.toMatchObject({
        reason: 'starter',
      });
    }
  }
  const named = await taskFixture({ named: true, allowStarterToDecide: true });
  await expect(
    store.decide({
      ...named.scope,
      actorId: userId,
      decision: 'approved',
      idempotencyKey: 'outside-audience',
    }),
  ).rejects.toMatchObject({ reason: 'audience' });
});
it('says a canceled task closed with its run, not that someone resolved it', async () => {
  const f = await taskFixture();
  await admin.query(
    `update app.pending_run_tasks set status='canceled',completed_at=clock_timestamp() where id=$1`,
    [f.taskId],
  );
  const command = {
    ...f.scope,
    decision: 'approved' as const,
    idempotencyKey: 'after-cancel',
  };
  expect((await store.read(command)).blockedReason).toBe('run_closed');
  await expect(store.decide(command)).rejects.toMatchObject({
    reason: 'run_closed',
  });
});
it('refuses everyone when a task has no captured audience', async () => {
  const f = await taskFixture();
  // Tasks opened before their setup was captured with defaults can lack one;
  // a missing audience must not read as "everyone".
  await admin.query(
    `update app.pending_run_tasks set config=config-'audience' where id=$1`,
    [f.taskId],
  );
  const command = {
    ...f.scope,
    decision: 'approved' as const,
    idempotencyKey: 'no-audience',
  };
  expect((await store.read(command)).blockedReason).toBe('audience');
  await expect(store.decide(command)).rejects.toMatchObject({
    reason: 'audience',
  });
});
it('keeps the decision name through profile edits and command replay; reads legacy outputs', async () => {
  const f = await taskFixture();
  const command = {
    ...f.scope,
    decision: 'approved' as const,
    idempotencyKey: 'captured-name',
  };
  const first = await store.decide(command);
  expect(first.task.output).toMatchObject({ decidedByName: 'Approver' });
  await admin.query(
    "update app.users set display_name='Renamed person' where id=$1",
    [f.deciderId],
  );
  expect((await store.read(f.scope)).completedByName).toBe('Approver');
  expect((await store.decide(command)).task.output).toEqual(first.task.output);
  await admin.query(
    "update app.pending_run_tasks set output_ref=(output_ref::jsonb #- '{value,decidedByName}')::json where id=$1",
    [f.taskId],
  );
  const legacy = await store.read(f.scope);
  expect(legacy.completedByName).toBe('Renamed person');
  expect(legacy.output).not.toHaveProperty('decidedByName');
});
