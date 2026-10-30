import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiPool } from '../support/workflow-authoring.js';
import { withTenantScopedClient } from '../../src/tenant-access/transactions.js';
import {
  seedNoticeWorkspace,
  seedFailure,
  seedApproval,
  observer,
  inbox,
  queryAsOwner,
} from './notices.fixture.js';
describe('current operational notice episodes', () => {
  it('coalesces a pause revision, resolves it, and notices a later pause without repeated poll churn', async () => {
    const f = await seedNoticeWorkspace();
    const run = await seedFailure(f.workspaceId, f.workflowId);
    await queryAsOwner(
      "update app.workflows set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),trigger_pause_reason='consecutive_failures',trigger_pause_failures=3,trigger_pause_last_run_id=$3,trigger_pause_revision=trigger_pause_revision+1 where workspace_id=$1 and id=$2",
      [f.workspaceId, f.workflowId, run],
      f.workspaceId,
    );
    const fold = observer(),
      read = inbox();
    const list = () =>
      read.listThreads({
        ...f.scope,
        filter: 'all',
        noticeKind: 'workflow_auto_paused',
        limit: 100,
      });
    await Promise.all([fold.observeCurrent?.(), observer().observeCurrent?.()]);
    const first = await list();
    expect(first.items).toMatchObject([
      { noticeKind: 'workflow_auto_paused', occurrenceCount: 1 },
    ]);
    await fold.observeCurrent?.();
    expect((await list()).revision).toBe(first.revision);
    await queryAsOwner(
      "update app.workflows set trigger_pause_state='none',trigger_paused_at=null,trigger_pause_reason=null,trigger_pause_failures=null,trigger_pause_last_run_id=null,trigger_pause_revision=trigger_pause_revision+1 where workspace_id=$1 and id=$2",
      [f.workspaceId, f.workflowId],
      f.workspaceId,
    );
    await fold.observeCurrent?.();
    expect((await list()).items).toEqual([]);
    await queryAsOwner(
      "update app.workflows set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),trigger_pause_reason='consecutive_failures',trigger_pause_failures=3,trigger_pause_last_run_id=$3,trigger_pause_revision=trigger_pause_revision+1 where workspace_id=$1 and id=$2",
      [f.workspaceId, f.workflowId, run],
      f.workspaceId,
    );
    await observer().observeCurrent?.();
    expect((await list()).items).toMatchObject([{ occurrenceCount: 2 }]);
  });
  it('ignores occupied active slots and coalesces actual queue/storage saturation, resolution and a new episode', async () => {
    const f = await seedNoticeWorkspace();
    await seedApproval(f.workspaceId, f.workflowId, {
      starter: f.members.owner,
    });
    const fold = observer(),
      read = inbox();
    const list = () =>
      read.listThreads({
        ...f.scope,
        filter: 'all',
        noticeKind: 'limit_reached',
        limit: 100,
      });
    await fold.observeCurrent?.();
    expect((await list()).items).toEqual([]);
    await queryAsOwner(
      'insert into app.workspace_artifact_capacity(workspace_id,charged_bytes,byte_limit,charged_count,artifact_count_limit) values($1,64,64,1,1)',
      [f.workspaceId],
      f.workspaceId,
    );
    await Promise.all([fold.observeCurrent?.(), observer().observeCurrent?.()]);
    const first = await list();
    expect(first.items).toMatchObject([
      {
        noticeKind: 'limit_reached',
        limits: ['artifact_bytes', 'artifact_count'],
        occurrenceCount: 1,
      },
    ]);
    await queryAsOwner(
      'update app.workspace_artifact_capacity set charged_bytes=65 where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    await fold.observeCurrent?.();
    expect((await list()).revision).toBe(first.revision);
    await queryAsOwner(
      'update app.workspace_artifact_capacity set charged_bytes=0,charged_count=0 where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    await fold.observeCurrent?.();
    expect((await list()).items).toEqual([]);
    await queryAsOwner(
      'update app.workspace_artifact_capacity set charged_bytes=64 where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    await fold.observeCurrent?.();
    expect((await list()).items).toMatchObject([
      { limits: ['artifact_bytes'], occurrenceCount: 2 },
    ]);
    await queryAsOwner(
      "insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit,effective_at) values($1,2,'active',10000,1,'-infinity')",
      [f.workspaceId],
      f.workspaceId,
    );
    await queryAsOwner(
      'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    const queued = randomUUID();
    await withTenantScopedClient(
      apiPool,
      { workspaceId: f.workspaceId },
      (client) =>
        client.query(
          "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','queued')",
          [queued, f.workspaceId, f.workflowId, randomUUID()],
        ),
    );
    await fold.observeCurrent?.();
    expect((await list()).items).toMatchObject([
      { limits: ['queue', 'artifact_bytes'], occurrenceCount: 2 },
    ]);
  });
  it('notices every paused workflow once when they span more than one page', async () => {
    const f = await seedNoticeWorkspace();
    const run = await seedFailure(f.workspaceId, f.workflowId);
    // More than the 100 subjects one observation pass reads.
    await queryAsOwner(
      `insert into app.workflows(id,workspace_id,name,created_by,trigger_pause_state,
         trigger_paused_at,trigger_pause_reason,trigger_pause_failures,trigger_pause_last_run_id)
       select gen_random_uuid(),$1,'Paused '||n,$2,'paused',clock_timestamp(),
         'consecutive_failures',3,$3
       from generate_series(1,150) n`,
      [f.workspaceId, f.scope.actorId, run],
      f.workspaceId,
    );
    const fold = observer();
    const paused = async () =>
      (
        await queryAsOwner<{ threads: number; repeated: number }>(
          `select count(*)::int threads,
             count(*) filter (where occurrence_count<>1)::int repeated
           from app.workspace_inbox_threads
           where workspace_id=$1 and notice_kind='workflow_auto_paused' and active`,
          [f.workspaceId],
          f.workspaceId,
        )
      )[0];

    await expect
      .poll(
        async () => {
          await fold.observeCurrent?.();
          return (await paused())?.threads;
        },
        { timeout: 30_000, interval: 0 },
      )
      .toBe(150);
    for (let pass = 0; pass < 4; pass += 1) await fold.observeCurrent?.();
    expect(await paused()).toEqual({ threads: 150, repeated: 0 });
  }, 60_000);
});
