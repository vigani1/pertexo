import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  acceptWorkflowRun,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from '../src/execution-acceptance.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../src/outbox.js';
import {
  acceptanceInput,
  apiDatabase,
  dispatcherDatabase,
  expectAcceptanceRecordCounts,
  hasPostgresCode,
  installExecutionAcceptanceFixture,
  migrationUrl,
  otherRequestHash,
  workerDatabase,
  workspaceA,
  workspaceB,
} from './execution-acceptance.fixtures.js';

installExecutionAcceptanceFixture();

describe('workflow run capacity admission', () => {
  it('atomically admits exactly one hundred of one hundred and one concurrent queued runs', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 101 }, (_, index) =>
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(
              createHash('sha256')
                .update(`request-${String(index)}`)
                .digest('hex'),
            ),
            keyHash: createHash('sha256')
              .update(`key-${String(index)}`)
              .digest('hex'),
            scope: `quota:${String(index)}`,
          }),
        ),
      ),
    );
    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(100);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(WorkspaceRunQuotaExceededError);
    await expectAcceptanceRecordCounts(100);

    const admitted = outcomes.find(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acceptWorkflowRun>>
      > => outcome.status === 'fulfilled',
    );
    if (admitted === undefined) throw new Error('Expected an admitted run');
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        update app.workflow_runs set status='running'
         where workspace_id=${workspaceA} and id=${admitted.value.runId}
      `),
    );
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, {
        ...acceptanceInput(
          createHash('sha256').update('replacement-request').digest('hex'),
        ),
        keyHash: createHash('sha256').update('replacement-key').digest('hex'),
        scope: 'quota:replacement',
      }),
    );
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          update app.workflow_runs set status='queued'
           where workspace_id=${workspaceA} and id=${admitted.value.runId}
        `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('PTA02'));
  });

  it('reserves active capacity before coordinator outbox work reaches BullMQ', async () => {
    const accepted = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(
              createHash('sha256')
                .update(`dispatch-request-${String(index)}`)
                .digest('hex'),
            ),
            keyHash: createHash('sha256')
              .update(`dispatch-key-${String(index)}`)
              .digest('hex'),
            scope: `dispatch:${String(index)}`,
          }),
        ),
      ),
    );
    const claim = () =>
      dispatcherDatabase.claimBatch({
        enabledJobNames: ['advance-workflow-run'],
        leaseDurationMillis: 30_000,
        leaseOwner: 'active-admission-test',
        leaseToken: randomUUID(),
        limit: 1,
        maxAttempts: 3,
      });
    const admittedEventIds: string[] = [];
    const admittedRunIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const batch = await claim();
      const event = batch.events[0];
      if (event === undefined)
        throw new Error(`Expected admitted outbox work ${String(index + 1)}`);
      admittedEventIds.push(event.id);
      admittedRunIds.push(event.aggregateId);
      await expect(
        dispatcherDatabase.markPublished(event.id, event.leaseToken),
      ).resolves.toBe(true);
    }
    await expect(claim()).resolves.toMatchObject({ events: [] });

    const otherEventId = randomUUID();
    const otherPayload = {
      schemaVersion: 1,
      workspaceId: workspaceB,
      outboxEventId: otherEventId,
    } as const;
    await apiDatabase.withWorkspace(workspaceB, (transaction) =>
      insertOutboxEvent(transaction, {
        id: otherEventId,
        jobName: 'phase0-duplicate-proof',
        schemaVersion: 1,
        aggregateType: 'fairness-probe',
        aggregateId: randomUUID(),
        payload: otherPayload,
        payloadChecksum: canonicalOutboxPayloadChecksum(otherPayload),
        availableAt: new Date(0),
      }),
    );
    const cursorOwner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await cursorOwner.query('begin');
      await cursorOwner.query('set local role pertexo_owner');
      await cursorOwner.query(
        `update app.outbox_fair_dispatch_cursor set last_workspace_id=$1`,
        [workspaceB],
      );
      await cursorOwner.query('commit');
    } finally {
      await cursorOwner.query('rollback').catch(() => undefined);
      await cursorOwner.end();
    }
    const mixedClaim = () =>
      dispatcherDatabase.claimBatch({
        enabledJobNames: ['advance-workflow-run', 'phase0-duplicate-proof'],
        leaseDurationMillis: 30_000,
        leaseOwner: 'saturated-window-test',
        leaseToken: randomUUID(),
        limit: 1,
        maxAttempts: 3,
      });
    await expect(mixedClaim()).resolves.toMatchObject({ events: [] });
    const afterSaturatedWindow = await mixedClaim();
    expect(afterSaturatedWindow.events[0]?.id).toBe(otherEventId);
    const otherEvent = afterSaturatedWindow.events[0];
    if (otherEvent === undefined)
      throw new Error('Expected fair probe delivery');
    await dispatcherDatabase.markPublished(
      otherEvent.id,
      otherEvent.leaseToken,
    );

    const firstEventId = admittedEventIds[0];
    if (firstEventId === undefined)
      throw new Error('Expected admitted outbox identity');
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `update app.workflow_run_active_admissions
            set recover_after='-infinity'::timestamptz
          where outbox_event_id=$1`,
        [firstEventId],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    const recovered = await claim();
    expect(recovered.events[0]?.id).not.toBe(firstEventId);
    expect(recovered.events[0]?.aggregateId).toBe(admittedRunIds[0]);
    expect(recovered.events[0]?.payloadChecksum).toBe(
      canonicalOutboxPayloadChecksum(recovered.events[0]?.payload),
    );
    const recoveredEvent = recovered.events[0];
    if (recoveredEvent === undefined)
      throw new Error('Expected recovered coordinator delivery');
    await expect(
      dispatcherDatabase.markPublished(
        recoveredEvent.id,
        recoveredEvent.leaseToken,
      ),
    ).resolves.toBe(true);

    const firstRunId = admittedRunIds[0];
    if (firstRunId === undefined)
      throw new Error('Expected admitted run identity');
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        update app.workflow_runs set status='running'
         where workspace_id=${workspaceA} and id=${firstRunId}
      `),
    );
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        update app.workflow_runs set status='succeeded'
         where workspace_id=${workspaceA} and id=${firstRunId}
      `),
    );
    const released = await claim();
    expect(released.events).toHaveLength(1);
    expect(
      accepted.some(({ runId }) => runId === released.events[0]?.aggregateId),
    ).toBe(true);
  });

  it('resolves an exact replay before a later entitlement suspension', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await owner.query(
        `insert into app.workspace_execution_entitlement_versions
           (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
         values ($1,2,'suspended',5,100,'-infinity'::timestamptz)`,
        [workspaceA],
      );
      await owner.query(
        `update app.workspace_execution_entitlements set current_version=2
          where workspace_id=$1`,
        [workspaceA],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
    ).resolves.toEqual({ ...first, duplicate: true });
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(otherRequestHash),
          keyHash: createHash('sha256').update('new-key').digest('hex'),
          scope: 'new-after-suspension',
        }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
    await expectAcceptanceRecordCounts(1);
  });

  it('lets an accepted run acquire and release its pinned slot after entitlement expiry', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await owner.query(
        `insert into app.workspace_execution_entitlement_versions
           (workspace_id,version,status,active_run_limit,queued_run_limit,
            effective_at,expires_at)
         values ($1,9,'active',5,100,'-infinity'::timestamptz,
                 clock_timestamp()+interval '1 second')`,
        [workspaceA],
      );
      await owner.query(
        `update app.workspace_execution_entitlements set current_version=9
          where workspace_id=$1`,
        [workspaceA],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
    );
    // The accepted run pins an immutable entitlement version whose expiry is
    // evaluated by PostgreSQL, so this intentionally crosses the database clock.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          update app.workflow_runs set status='running'
           where workspace_id=${workspaceA} and id=${accepted.runId}
        `),
      ),
    ).resolves.toBeDefined();
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          update app.workflow_runs set status='succeeded'
           where workspace_id=${workspaceA} and id=${accepted.runId}
        `),
      ),
    ).resolves.toBeDefined();
    const counters = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{ active_runs: number; queued_runs: number }>(sql`
        select active_runs,queued_runs
          from app.workspace_execution_admission_counters
      `),
    );
    expect(counters.rows).toEqual([{ active_runs: 0, queued_runs: 0 }]);
  });

  it('enforces five active runs while waiting retains and terminal state releases the slot', async () => {
    const accepted = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(
              createHash('sha256')
                .update(`active-request-${String(index)}`)
                .digest('hex'),
            ),
            keyHash: createHash('sha256')
              .update(`active-key-${String(index)}`)
              .digest('hex'),
            scope: `active:${String(index)}`,
          }),
        ),
      ),
    );
    const starts = await Promise.allSettled(
      accepted.map(({ runId }) =>
        workerDatabase.withWorkspace(workspaceA, ({ db }) =>
          db.execute(sql`
            update app.workflow_runs set status='running'
             where workspace_id=${workspaceA} and id=${runId} and status='queued'
          `),
        ),
      ),
    );
    expect(starts.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      5,
    );
    expect(
      starts.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected',
      )?.reason,
    ).toSatisfy(hasPostgresCode('PTA03'));

    const statuses = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{ id: string; status: string }>(sql`
        select id,status from app.workflow_runs order by id
      `),
    );
    const running = statuses.rows.filter(({ status }) => status === 'running');
    const queued = statuses.rows.find(({ status }) => status === 'queued');
    expect(running).toHaveLength(5);
    expect(queued).toBeDefined();
    const waitingId = running[0]?.id;
    if (waitingId === undefined || queued === undefined)
      throw new Error('Active admission fixture is incomplete');
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(
        sql`update app.workflow_runs set status='waiting' where id=${waitingId}`,
      ),
    );
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(
          sql`update app.workflow_runs set status='running' where id=${queued.id}`,
        ),
      ),
    ).rejects.toSatisfy(hasPostgresCode('PTA03'));
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(
        sql`update app.workflow_runs set status='succeeded' where id=${waitingId}`,
      ),
    );
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(
          sql`update app.workflow_runs set status='running' where id=${queued.id}`,
        ),
      ),
    ).resolves.toBeDefined();
    const counters = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{ active_runs: number; queued_runs: number }>(sql`
        select active_runs,queued_runs
          from app.workspace_execution_admission_counters
      `),
    );
    expect(counters.rows).toEqual([{ active_runs: 5, queued_runs: 0 }]);
  });

  it('repairs admission counters from authoritative run state', async () => {
    await Promise.all(
      [0, 1].map((index) =>
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(
              createHash('sha256')
                .update(`repair-${String(index)}`)
                .digest('hex'),
            ),
            keyHash: createHash('sha256')
              .update(`repair-key-${String(index)}`)
              .digest('hex'),
            scope: `repair:${String(index)}`,
          }),
        ),
      ),
    );
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await owner.query(
        `update app.workspace_execution_admission_counters
            set queued_runs=99,active_runs=99 where workspace_id=$1`,
        [workspaceA],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    const repaired = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute<{ active_runs: number; queued_runs: number }>(sql`
        select * from app.reconcile_workspace_execution_admission(${workspaceA})
      `),
    );
    expect(repaired.rows).toEqual([{ queued_runs: 2, active_runs: 0 }]);
  });
});
