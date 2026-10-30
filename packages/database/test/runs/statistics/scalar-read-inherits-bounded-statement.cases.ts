import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  checkDatabaseReadiness,
  EXPECTED_MIGRATION_HEAD,
} from '../../../src/platform/readiness.queries.js';
import { WorkspaceAccessDeniedError } from '../../../src/tenant-access/errors.js';

import {
  ownerPool,
  runtimePool,
  runs,
  person,
  busyWorkspace,
  quietWorkspace,
  intake,
  elsewhere,
  inWorkspace,
  addRuns,
} from './fixture.js';

export function registerScalarReadInheritsBoundedStatement(): void {
  it('the scalar read inherits the bounded statement timeout', async () => {
    const blocker = await ownerPool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query(
        'lock table app.workflow_run_active_admissions in access exclusive mode',
      );
      await expect(
        runs.usageCapacity({ workspaceId: busyWorkspace }),
      ).rejects.toMatchObject({ cause: { code: '57014' } });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });

  it('still returns a snapshot while the workspace is suspended', async () => {
    await inWorkspace('owner', busyWorkspace, {
      text: `update app.workspaces set status='suspended' where id=$1`,
      values: [busyWorkspace],
    });
    await expect(
      runs.usageCapacity({ workspaceId: busyWorkspace }),
    ).resolves.toMatchObject({ execution: { activeRuns: 0 } });
  });

  it.each(['pending_deletion'])(
    'does not return a snapshot after workspace becomes %s',
    async (status) => {
      await inWorkspace('owner', busyWorkspace, {
        text: `update app.workspaces set status=$2::varchar,
      deletion_requested_at=case when $2='pending_deletion' then now() else null end,
      deletion_requested_by=case when $2='pending_deletion' then $3::uuid else null end,
      deletion_reason=case when $2='pending_deletion' then 'Capacity test' else null end,
      purge_after=case when $2='pending_deletion' then now()+interval '30 days' else null end
      where id=$1`,
        values: [busyWorkspace, status, person],
      });
      await expect(
        runs.usageCapacity({ workspaceId: busyWorkspace }),
      ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    },
  );

  it('does not return lazy defaults for a missing workspace', async () => {
    await expect(
      runs.usageCapacity({ workspaceId: randomUUID() }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it('reports provisioned execution and lazy artifact defaults', async () => {
    const result = await runs.usageCapacity({ workspaceId: busyWorkspace });
    expect(result.execution).toEqual({
      activeRuns: 0,
      reservedActiveSlots: 0,
      activeCapacityConsumed: 0,
      queuedRuns: 0,
      policy: {
        state: 'active',
        version: 1,
        activeRunLimit: 5,
        queuedRunLimit: 100,
      },
    });
    expect(result.artifacts).toEqual({
      chargedBytes: '0',
      byteLimit: '1073741824',
      chargedCount: 0,
      artifactCountLimit: 1000,
      source: 'default',
    });
    expect(result.asOf).toMatch(/\.\d{6}Z$/u);
    await expect(checkDatabaseReadiness(runtimePool)).resolves.toMatchObject({
      migrationHead: EXPECTED_MIGRATION_HEAD,
    });
  });

  it('counts active reservations without double counting queued runs or other tenants', async () => {
    await addRuns(busyWorkspace, intake, {
      status: 'running',
      count: 1,
      age: '2 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'waiting',
      count: 1,
      age: '2 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'queued',
      count: 2,
      age: '2 hours',
    });
    await addRuns(quietWorkspace, elsewhere, {
      status: 'running',
      count: 1,
      age: '2 hours',
    });
    await addRuns(quietWorkspace, elsewhere, {
      status: 'queued',
      count: 1,
      age: '2 hours',
    });
    for (const workspace of [busyWorkspace, quietWorkspace]) {
      await inWorkspace('owner', workspace, {
        text: `with selected as (
      select id from app.workflow_runs where workspace_id=$1 and status='queued' limit 1
    ), event as (
      insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
      select gen_random_uuid(),$1,'advance-workflow-run','workflow-run',id,'{}'::jsonb,repeat('a',64)  from selected returning id,aggregate_id
    ) insert into app.workflow_run_active_admissions(workspace_id,workflow_run_id,outbox_event_id)
      select $1,aggregate_id,id from event`,
        values: [workspace],
      });
    }
    const result = await runs.usageCapacity({ workspaceId: busyWorkspace });
    expect(result.execution).toMatchObject({
      activeRuns: 2,
      reservedActiveSlots: 1,
      activeCapacityConsumed: 3,
      queuedRuns: 2,
    });
    const counter = await inWorkspace('api', busyWorkspace, {
      text: 'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
      values: [busyWorkspace],
    });
    expect(counter.rows[0]?.active_runs).toBe(2);
    const reservations = await inWorkspace('api', busyWorkspace, {
      text: 'select workspace_id from app.workflow_run_active_admissions',
    });
    expect(reservations.rows).toEqual([{ workspace_id: busyWorkspace }]);
    const otherWorkspace = await inWorkspace('api', busyWorkspace, {
      text: 'select * from app.workflow_run_active_admissions where workspace_id=$1',
      values: [quietWorkspace],
    });
    expect(otherWorkspace.rows).toEqual([]);
    const withoutContext = await runtimePool.query(
      'select * from app.workflow_run_active_admissions',
    );
    expect(withoutContext.rows).toEqual([]);
    await expect(
      inWorkspace('api', busyWorkspace, {
        text: 'delete from app.workflow_run_active_admissions where workspace_id=$1',
        values: [busyWorkspace],
      }),
    ).rejects.toThrow(/permission denied/u);
  });

  it.each([
    ['suspended', 'suspended', '-infinity', null],
    ['not_yet_effective', 'active', 'infinity', null],
    ['expired', 'active', '-infinity', '2000-01-01'],
  ])(
    'reports configured %s policy without inventing effective limits',
    async (state, status, effectiveAt, expiresAt) => {
      await inWorkspace('owner', busyWorkspace, {
        text: `insert into app.workspace_execution_entitlement_versions
      (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at,expires_at)
      values($1,2,$2,7,120,$3::timestamptz,$4::timestamptz)`,
        values: [busyWorkspace, status, effectiveAt, expiresAt],
      });
      await inWorkspace('owner', busyWorkspace, {
        text: 'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
        values: [busyWorkspace],
      });
      expect(
        (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution
          .policy,
      ).toEqual({ state, version: 2, activeRunLimit: 7, queuedRunLimit: 120 });
    },
  );

  it('reports missing counter authority unavailable, then missing pointer with nullable limits', async () => {
    await inWorkspace('owner', busyWorkspace, {
      text: 'delete from app.workspace_execution_admission_counters where workspace_id=$1',
      values: [busyWorkspace],
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution
        .policy,
    ).toEqual({
      state: 'unavailable',
      version: 1,
      activeRunLimit: 5,
      queuedRunLimit: 100,
    });
    await inWorkspace('owner', busyWorkspace, {
      text: 'delete from app.workspace_execution_entitlements where workspace_id=$1',
      values: [busyWorkspace],
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution
        .policy,
    ).toEqual({
      state: 'unavailable',
      version: null,
      activeRunLimit: null,
      queuedRunLimit: null,
    });
  });
}
