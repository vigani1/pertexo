import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  apiPool,
  apiUrl,
  purgeTestWorkspace,
} from '../support/workflow-authoring.js';
import { useInstanceCapacity } from '../support/instance-capacity.js';
import type { NoticeMailToSeal } from '../../src/inbox/mail/contract.js';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import {
  seedNoticeWorkspace,
  observer,
  inbox,
  queryAsOwner,
  preferences,
  mail,
} from './notices.fixture.js';

describe('capacity warning episodes', () => {
  useInstanceCapacity(
    {
      activeRunLimit: 5,
      queuedRunLimit: 100,
      artifactCountLimit: 1_000,
    },
    apiUrl,
  );
  it('warns at exactly 80%, keeps limits independent and rearms only after a drop', async () => {
    const f = await seedNoticeWorkspace();
    await queryAsOwner(
      'insert into app.workspace_artifact_capacity(workspace_id,charged_bytes,byte_limit,charged_count,artifact_count_limit) values($1,79,100,7,10)',
      [f.workspaceId],
      f.workspaceId,
    );
    const fold = observer(),
      read = inbox();
    const list = () =>
      read.listThreads({
        ...f.scope,
        filter: 'all',
        noticeKind: 'limit_approaching',
        limit: 100,
      });
    await fold.observeCurrent?.();
    expect((await list()).items).toEqual([]);
    await queryAsOwner(
      'update app.workspace_artifact_capacity set charged_bytes=80,charged_count=8 where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    await Promise.all([fold.observeCurrent?.(), observer().observeCurrent?.()]);
    const first = await list();
    expect(first.items).toHaveLength(2);
    expect(first.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          limits: ['artifact_bytes'],
          occurrenceCount: 1,
        }),
        expect.objectContaining({
          limits: ['artifact_count'],
          occurrenceCount: 1,
        }),
      ]),
    );
    await queryAsOwner(
      'update app.workspace_artifact_capacity set charged_bytes=90 where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    await observer().observeCurrent?.();
    expect((await list()).revision).toBe(first.revision);
    await queryAsOwner(
      'update app.workspace_artifact_capacity set charged_count=7 where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    await fold.observeCurrent?.();
    expect((await list()).items).toMatchObject([
      { limits: ['artifact_bytes'], occurrenceCount: 1 },
    ]);
    await queryAsOwner(
      'update app.workspace_artifact_capacity set charged_count=8 where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    await observer().observeCurrent?.();
    expect((await list()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          limits: ['artifact_bytes'],
          occurrenceCount: 1,
        }),
        expect.objectContaining({
          limits: ['artifact_count'],
          occurrenceCount: 2,
        }),
      ]),
    );
  });

  it('compares bigint storage at the exact crossing without overflow or rounding', async () => {
    const f = await seedNoticeWorkspace();
    await queryAsOwner(
      'insert into app.workspace_artifact_capacity(workspace_id,charged_bytes,byte_limit,charged_count,artifact_count_limit) values($1,7378697629483820645,9223372036854775807,0,1000)',
      [f.workspaceId],
      f.workspaceId,
    );
    const fold = observer(),
      read = inbox();
    const list = () =>
      read.listThreads({
        ...f.scope,
        filter: 'all',
        noticeKind: 'limit_approaching',
        limit: 100,
      });
    await fold.observeCurrent?.();
    expect((await list()).items).toEqual([]);
    await queryAsOwner(
      'update app.workspace_artifact_capacity set charged_bytes=charged_bytes+1 where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    await fold.observeCurrent?.();
    expect((await list()).items).toMatchObject([
      { limits: ['artifact_bytes'], occurrenceCount: 1 },
    ]);
  });

  it('warns for actual occupied active capacity and resolves when it is released', async () => {
    const f = await seedNoticeWorkspace();
    const ids = Array.from({ length: 4 }, () => randomUUID());
    const fold = observer(),
      read = inbox();
    const list = () =>
      read.listThreads({
        ...f.scope,
        filter: 'all',
        noticeKind: 'limit_approaching',
        limit: 100,
      });
    for (const id of ids.slice(0, 3))
      await withTenantScopedClient(
        apiPool,
        { workspaceId: f.workspaceId },
        (client) =>
          client.query(
            "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','running')",
            [id, f.workspaceId, f.workflowId, randomUUID()],
          ),
      );
    await fold.observeCurrent?.();
    expect((await list()).items).toEqual([]);
    await withTenantScopedClient(
      apiPool,
      { workspaceId: f.workspaceId },
      (client) =>
        client.query(
          "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','running')",
          [ids[3], f.workspaceId, f.workflowId, randomUUID()],
        ),
    );
    await fold.observeCurrent?.();
    expect((await list()).items).toMatchObject([
      { limits: ['active'], occurrenceCount: 1 },
    ]);
    await withTenantScopedClient(
      apiPool,
      { workspaceId: f.workspaceId },
      (client) =>
        client.query(
          "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp() where id=$1",
          [ids[3]],
        ),
    );
    await fold.observeCurrent?.();
    expect((await list()).items).toEqual([]);
  });

  it('counts held dispatcher reservations and keeps the operational audience', async () => {
    const f = await seedNoticeWorkspace();
    await withTenantScopedClient(
      apiPool,
      { workspaceId: f.workspaceId },
      (client) =>
        client.query(
          `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
       select gen_random_uuid(),$1,$2,gen_random_uuid(),'manual','queued' from generate_series(1,4)`,
          [f.workspaceId, f.workflowId],
        ),
    );
    await queryAsOwner(
      `with events as (insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
       select gen_random_uuid(),$1,'advance-workflow-run','workflow-run',id,'{}',repeat('a',64)
       from app.workflow_runs where workspace_id=$1 and status='queued' returning id,aggregate_id)
       insert into app.workflow_run_active_admissions(workspace_id,workflow_run_id,outbox_event_id) select $1,aggregate_id,id from events`,
      [f.workspaceId],
      f.workspaceId,
    );
    await observer().observeCurrent?.();
    const read = inbox();
    for (const role of [
      'owner',
      'admin',
      'operator',
      'builder',
      'viewer',
    ] as const) {
      const result = await read.listThreads({
        workspaceId: f.workspaceId,
        actorId: f.members[role],
        filter: 'all',
        noticeKind: 'limit_approaching',
        limit: 100,
      });
      expect(result.items).toHaveLength(
        ['owner', 'admin', 'operator'].includes(role) ? 1 : 0,
      );
    }
    expect(
      (
        await read.listThreads({
          ...f.scope,
          filter: 'all',
          noticeKind: 'limit_approaching',
          limit: 100,
        })
      ).items,
    ).toMatchObject([{ limits: ['active'], occurrenceCount: 1 }]);
  });

  it.each([
    'workspace_execution_entitlements',
    'workspace_execution_admission_counters',
    'suspended_policy',
    'expired_policy',
    'future_policy',
  ] as const)(
    'resolves an existing queue warning when %s supplies no current authority',
    async (authority) => {
      const f = await seedNoticeWorkspace();
      await queryAsOwner(
        "insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit,effective_at) values($1,2,'active',5,5,'-infinity')",
        [f.workspaceId],
        f.workspaceId,
      );
      await queryAsOwner(
        'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
        [f.workspaceId],
        f.workspaceId,
      );
      await withTenantScopedClient(
        apiPool,
        { workspaceId: f.workspaceId },
        (client) =>
          client.query(
            `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
         select gen_random_uuid(),$1,$2,gen_random_uuid(),'manual','queued' from generate_series(1,4)`,
            [f.workspaceId, f.workflowId],
          ),
      );
      const fold = observer(),
        read = inbox();
      const list = () =>
        read.listThreads({
          ...f.scope,
          filter: 'all',
          noticeKind: 'limit_approaching',
          limit: 100,
        });
      await fold.observeCurrent?.();
      expect((await list()).items).toMatchObject([
        { limits: ['queue'], occurrenceCount: 1 },
      ]);
      if (
        authority === 'workspace_execution_entitlements' ||
        authority === 'workspace_execution_admission_counters'
      )
        await queryAsOwner(
          `delete from app.${authority} where workspace_id=$1`,
          [f.workspaceId],
          f.workspaceId,
        );
      else {
        await queryAsOwner(
          `insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit,effective_at,expires_at)
         values($1,3,$2,5,5,statement_timestamp()+$3::interval,statement_timestamp()+$4::interval)`,
          [
            f.workspaceId,
            authority === 'suspended_policy' ? 'suspended' : 'active',
            authority === 'future_policy' ? '1 hour' : '-2 hours',
            authority === 'expired_policy' ? '-1 hour' : null,
          ],
          f.workspaceId,
        );
        await queryAsOwner(
          'update app.workspace_execution_entitlements set current_version=3 where workspace_id=$1',
          [f.workspaceId],
          f.workspaceId,
        );
      }
      await observer().observeCurrent?.();
      expect((await list()).items).toEqual([]);
    },
  );

  it('uses F27 email preferences and rechecks current capacity before sending', async () => {
    const f = await seedNoticeWorkspace();
    await preferences().replace({
      ...f.scope,
      mode: 'immediate',
      hour: 9,
      timeZone: 'UTC',
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await queryAsOwner(
      'insert into app.workspace_artifact_capacity(workspace_id,charged_bytes,byte_limit,charged_count,artifact_count_limit) values($1,80,100,0,1000)',
      [f.workspaceId],
      f.workspaceId,
    );
    await observer().observeCurrent?.();
    const captured: NoticeMailToSeal[] = [];
    const sender = mail(captured);
    await sender.prepare();
    const prepared = captured.filter(
      (item) => item.workspaceId === f.workspaceId,
    );
    expect(prepared).toHaveLength(1);
    const batch = prepared[0];
    if (batch === undefined) throw new Error('Missing warning mail');
    expect(batch.items).toMatchObject([
      { noticeKind: 'limit_approaching', name: 'File storage' },
    ]);
    expect(await sender.authorize(batch.id)).toBe(true);
    await queryAsOwner(
      'update app.workspace_artifact_capacity set charged_bytes=70 where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    expect(await sender.authorize(batch.id)).toBe(false);
    expect(await purgeTestWorkspace(f.workspaceId)).toContain(
      'personal_notice_mail',
    );
    for (const table of [
      'workspace_inbox_threads',
      'notice_mail_batches',
      'notice_mail_items',
    ])
      expect(
        await queryAsOwner(
          `select workspace_id from app.${table} where workspace_id=$1`,
          [f.workspaceId],
          f.workspaceId,
        ),
      ).toHaveLength(0);
    expect(
      await queryAsOwner(
        'select id from app.system_mail_deliveries where id=$1',
        [batch.id],
      ),
    ).toHaveLength(0);
  });

  it('does not describe zero capacity as an approaching limit', async () => {
    const f = await seedNoticeWorkspace();
    await queryAsOwner(
      'insert into app.workspace_artifact_capacity(workspace_id,charged_bytes,byte_limit,charged_count,artifact_count_limit) values($1,0,0,0,0)',
      [f.workspaceId],
      f.workspaceId,
    );
    await observer().observeCurrent?.();
    expect(
      (
        await inbox().listThreads({
          ...f.scope,
          filter: 'all',
          noticeKind: 'limit_approaching',
          limit: 100,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await inbox().listThreads({
          ...f.scope,
          filter: 'all',
          noticeKind: 'limit_reached',
          limit: 100,
        })
      ).items,
    ).toMatchObject([{ limits: ['artifact_bytes', 'artifact_count'] }]);
  });
});
