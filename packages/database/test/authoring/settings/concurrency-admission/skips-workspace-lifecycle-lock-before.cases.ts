import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';

import {
  apiDatabase,
  hasPostgresCode,
  workerDatabase,
  workspaceA,
  waitForDatabaseLock,
  workflowId,
  workflowVersionId,
} from '../../../runs/acceptance/fixtures.js';
import {
  acceptRun,
  claimRuns,
  readTickets,
  setLimit,
  withConcurrencyControls,
  withOwner,
} from '../concurrency-admission.fixtures.js';

export function registerSkipsWorkspaceLifecycleLockBefore(): void {
  it('skips a workspace lifecycle lock before grants while settings wait without holding the counter', async () => {
    await setLimit(1);
    const run = await acceptRun();
    let settings: Promise<void> | undefined;
    try {
      await withOwner(async (client) => {
        await client.query(
          'select id from app.workspaces where id=$1 for update',
          [workspaceA],
        );
        const pid = (
          await client.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        if (pid === undefined)
          throw new Error('Missing workspace lock owner PID');
        settings = setLimit(1);
        await waitForDatabaseLock(pid);
        await expect(claimRuns()).resolves.toMatchObject({ events: [] });
      });
      await settings;
      expect((await claimRuns()).events[0]?.aggregateId).toBe(run.runId);
    } finally {
      await settings?.catch(() => undefined);
    }
  }, 5_000);

  it('rejects direct active inserts for capped workflows, including protocol-aware writers', async () => {
    await setLimit(1);
    for (const database of [apiDatabase, workerDatabase]) {
      for (const protocol of [false, true]) {
        await expect(
          database.withWorkspace(workspaceA, async ({ db }) => {
            if (protocol)
              await db.execute(
                sql`select set_config('app.workflow_concurrency_protocol','1',true)`,
              );
            await db.execute(sql`insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
            values(${randomUUID()},${workspaceA},${workflowId},${workflowVersionId},'api','running')`);
          }),
        ).rejects.toSatisfy(hasPostgresCode(protocol ? 'PTC02' : 'PTC01'));
      }
    }
    expect(await readTickets()).toEqual([]);
  });

  it('serializes authenticated policy CAS with acceptance and grants and replays the exact audit result', async () => {
    await withConcurrencyControls(async (controls, scope) => {
      const auditRequestIds = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ] as const;
      const command = {
        ...scope,
        limit: 1,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        requestId: auditRequestIds[0],
      };
      const [changed] = await Promise.all([
        controls.updateSettings(command),
        ...Array.from({ length: 4 }, () => acceptRun()),
      ]);
      expect(changed.settings).toMatchObject({
        limit: 1,
        revision: 2,
        overflow: 'queue',
      });
      const claims = await Promise.all(
        Array.from({ length: 4 }, () => claimRuns(1)),
      );
      expect(claims.flatMap(({ events }) => events)).toHaveLength(1);
      const replay = await controls.updateSettings(command);
      expect(replay).toEqual({ ...changed, replayed: true });
      const conflicts = await Promise.allSettled([
        controls.updateSettings({
          ...scope,
          limit: 2,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
          requestId: auditRequestIds[1],
        }),
        controls.updateSettings({
          ...scope,
          limit: 3,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
          requestId: auditRequestIds[2],
        }),
        claimRuns(1),
      ]);
      expect(
        conflicts.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const rejected = conflicts.find((result) => result.status === 'rejected');
      expect(
        rejected?.status === 'rejected' ? rejected.reason : undefined,
      ).toMatchObject({
        name: 'WorkflowConcurrencyRevisionConflictError',
        currentRevision: 3,
      });
      expect(
        await withOwner(
          async (client) =>
            (
              await client.query<{ n: number }>(
                "select count(*)::int n from app.audit_events where workspace_id=$1 and action='workflow.concurrency_settings_changed' and request_id=any($2::text[])",
                [workspaceA, auditRequestIds],
              )
            ).rows[0]?.n,
        ),
      ).toBe(2);
    });
  });

  it('bounds positive settings by active current entitlement but permits exact replay and removal after suspension', async () => {
    await withConcurrencyControls(async (controls, scope) => {
      await expect(
        controls.updateSettings({
          ...scope,
          limit: 6,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowConcurrencyLimitExceededError',
        maximum: 5,
      });
      const command = {
        ...scope,
        limit: 4,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      };
      const original = await controls.updateSettings(command);
      await withOwner(async (client) => {
        await client.query(
          `insert into app.workspace_execution_entitlement_versions
          (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
          values($1,2,'suspended',1,100,'-infinity'::timestamptz)`,
          [workspaceA],
        );
        await client.query(
          'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
          [workspaceA],
        );
      });
      expect(await controls.readSettings(scope)).toMatchObject({
        limit: 4,
        revision: 2,
        workspaceActiveRunLimit: null,
        workspacePolicyState: 'suspended',
      });
      expect(await controls.updateSettings(command)).toEqual({
        ...original,
        replayed: true,
      });
      await expect(
        controls.updateSettings({
          ...scope,
          limit: 1,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowConcurrencyLimitUnavailableError',
      });
      expect(
        await controls.updateSettings({
          ...scope,
          limit: null,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
        }),
      ).toMatchObject({
        settings: {
          limit: null,
          revision: 3,
          workspacePolicyState: 'suspended',
        },
        replayed: false,
      });
    });
  });
}
