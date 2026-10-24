import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  acceptWorkflowRun,
  WorkspaceRunAdmissionDeniedError,
} from '../../../../src/runs/commands/acceptance.repository.js';

import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  hasPostgresCode,
  migrationUrl,
  otherRequestHash,
  workerDatabase,
  workspaceA,
} from '../fixtures.js';

export function registerResolvesExactReplayBeforeLater(): void {
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
                 clock_timestamp()+interval '5 seconds')`,
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
    await expect
      .poll(
        async () => {
          const timing = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
            db.execute<{ expired: boolean; expires_at: Date }>(sql`
          select clock_timestamp() >= version.expires_at expired,
                 version.expires_at
          from app.workspace_execution_entitlement_versions version
          where version.workspace_id=${workspaceA} and version.version=9
        `),
          );
          const row = timing.rows[0];
          if (row === undefined)
            throw new Error('Pinned entitlement is missing');
          expect(accepted.acceptedAt.getTime()).toBeLessThan(
            new Date(row.expires_at).getTime(),
          );
          return row.expired;
        },
        { timeout: 10_000, interval: 20 },
      )
      .toBe(true);
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
  }, 15_000);

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
}
