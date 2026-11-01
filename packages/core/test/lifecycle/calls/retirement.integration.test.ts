import { createWorkflowRunDatabase } from '../../../src/runs/runs.repository.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { enforceRetention } from '../../support/retention.js';
import { purgeWorkspace } from '../../support/workspace-purge.js';
import {
  adminUrl,
  userId,
  apiUrl,
  maintenanceUrl,
  randomUUID,
  withDatabase,
} from '../retention.support.js';
import {
  admin,
  callRow,
  createFamily as createRetainedFamily,
  daysAgo,
  insertBorrowedSlot,
  runRow,
} from './fixtures.js';

async function createFamily(
  input: Parameters<typeof createRetainedFamily>[0] = {},
) {
  const family = await createRetainedFamily(input);
  await admin.query(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active') on conflict do nothing",
    [family.workspaceId, userId],
  );
  return family;
}

const reads = createWorkflowRunDatabase(
  parseDatabaseConfig({ connectionString: withDatabase(apiUrl), max: 1 }),
);
afterAll(() => reads.close());
const retire = () => enforceRetention(maintenanceUrl, 2);

describe('parent-owned call retention', () => {
  it('retires child detail while keeping an unconsumed result for a live parent', async () => {
    const family = await createFamily({ childDays: 31 });
    await retire();
    expect(await runRow(family.childRunId)).toMatchObject({
      output_ref: null,
      details_purged_at: expect.any(Date) as unknown,
    });
    expect(await runRow(family.parentRunId)).toMatchObject({
      input_ref: { kind: 'inline', value: { input: family.parentRunId } },
      details_purged_at: null,
    });
    expect(await callRow(family.callId)).toMatchObject({
      result_ref: { kind: 'inline', value: { result: family.childRunId } },
      details_purged_at: null,
      live_child_run_id: family.childRunId,
    });
  });

  it('detaches a child summary at 90 days without erasing its identity or needed result', async () => {
    const family = await createFamily({ childDays: 91 });
    await retire();
    expect(await runRow(family.childRunId)).toBeUndefined();
    expect(
      (
        await reads.get({
          actorId: userId,
          workspaceId: family.workspaceId,
          runId: family.parentRunId,
        })
      )?.calls,
    ).toMatchObject([
      {
        childRunId: family.childRunId,
        childHistory: 'expired',
        status: 'succeeded',
        detailsRetired: false,
      },
    ]);
    expect(await callRow(family.callId)).toMatchObject({
      child_run_id: family.childRunId,
      live_child_run_id: null,
      status: 'succeeded',
      result_ref: { kind: 'inline', value: { result: family.childRunId } },
    });
  });

  it('clears consumed payloads only at parent detail expiry, and deletes identity with its summary', async () => {
    const family = await createFamily({
      childDays: 40,
      parentDays: 29,
      consumed: true,
    });
    await retire();
    expect((await callRow(family.callId))?.result_ref).not.toBeNull();
    await admin.query(
      'update app.workflow_runs set completed_at=$2 where id=$1',
      [family.parentRunId, daysAgo(31)],
    );
    await retire();
    expect(await callRow(family.callId)).toMatchObject({
      input_ref: null,
      result_ref: null,
      details_purged_at: expect.any(Date) as unknown,
      child_run_id: family.childRunId,
    });
    expect(
      (
        await reads.get({
          actorId: userId,
          workspaceId: family.workspaceId,
          runId: family.parentRunId,
        })
      )?.calls,
    ).toMatchObject([{ detailsRetired: true, status: 'succeeded' }]);
    await admin.query(
      'update app.workflow_runs set completed_at=$2 where id=$1',
      [family.parentRunId, daysAgo(91)],
    );
    await retire();
    expect(await runRow(family.parentRunId)).toBeUndefined();
    expect(await callRow(family.callId)).toBeUndefined();
    expect(await runRow(family.childRunId)).toBeDefined();
  });

  it('keeps expired input for both live sides and before a parent has its first call intent', async () => {
    const family = await createFamily();
    await admin.query('delete from app.workflow_calls where id=$1', [
      family.callId,
    ]);
    await retire();
    expect((await runRow(family.parentRunId))?.input_ref).not.toBeNull();
    // A live run retains its input even before a Call relation owns it.
    expect((await runRow(family.childRunId))?.input_ref).not.toBeNull();
    await admin.query(
      "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp() where id=$1",
      [family.childRunId],
    );
    await retire();
    expect((await runRow(family.childRunId))?.input_ref).toBeNull();
    const accepted = await createFamily();
    await retire();
    expect((await runRow(accepted.parentRunId))?.input_ref).not.toBeNull();
    expect((await runRow(accepted.childRunId))?.input_ref).not.toBeNull();
  });

  it('does not purge summaries or call payloads while a slot return remains outstanding', async () => {
    const family = await createFamily({
      childDays: 91,
      parentDays: 91,
      consumed: true,
      slotLent: true,
    });
    await retire();
    expect(await runRow(family.parentRunId)).toBeDefined();
    expect(await runRow(family.childRunId)).toBeDefined();
    expect(await callRow(family.callId)).toMatchObject({
      live_child_run_id: family.childRunId,
      details_purged_at: null,
    });
    await admin.query(
      'update app.workflow_calls set slot_lent=false where id=$1',
      [family.callId],
    );
    await retire();
    expect(await runRow(family.parentRunId)).toBeUndefined();
    expect(await runRow(family.childRunId)).toBeUndefined();
  });

  it('skips a child locked by completion and retries its retirement after settlement', async () => {
    const family = await createFamily({ childDays: 91 });
    const completing = new Client({ connectionString: withDatabase(adminUrl) });
    await completing.connect();
    try {
      await completing.query('begin');
      await completing.query(
        'select id from app.workflow_runs where id=$1 for no key update',
        [family.childRunId],
      );
      await completing.query(
        'select id from app.workflow_calls where id=$1 for no key update',
        [family.callId],
      );
      await retire();
      expect(await runRow(family.childRunId)).toBeDefined();
      expect((await callRow(family.callId))?.live_child_run_id).toBe(
        family.childRunId,
      );
    } finally {
      await completing.query('rollback');
      await completing.end();
    }
    await retire();
    expect(await runRow(family.childRunId)).toBeUndefined();
    expect((await callRow(family.callId))?.live_child_run_id).toBeNull();
  });

  it('keeps the unique spawn identity after its 24-hour acceptance receipt expires', async () => {
    const family = await createFamily();
    const receiptId = randomUUID();
    await admin.query(
      `insert into app.idempotency_records
       (id,workspace_id,scope,operation,key_hash,request_hash,status,resource_id,result_ref,created_at,expires_at)
       values($1,$2,'workflow-call','run.start',$3,$3,'completed',$4,'{}',$5,$6)`,
      [
        receiptId,
        family.workspaceId,
        'a'.repeat(64),
        family.childRunId,
        daysAgo(2),
        daysAgo(1),
      ],
    );
    await retire();
    expect(
      (
        await admin.query(
          'select id from app.idempotency_records where id=$1',
          [receiptId],
        )
      ).rowCount,
    ).toBe(0);
    expect(await callRow(family.callId)).toMatchObject({
      child_run_id: family.childRunId,
    });
    await expect(
      admin.query(
        `insert into app.workflow_calls
       (id,workspace_id,parent_run_id,invocation_key,target_workflow_id,target_version_id,target_checksum,input_checksum,status)
       select $2,workspace_id,parent_run_id,invocation_key,target_workflow_id,target_version_id,target_checksum,input_checksum,'pending'
       from app.workflow_calls where id=$1`,
        [family.callId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('enforces exact workspace-qualified pins and hides relations outside application scope', async () => {
    const first = await createFamily();
    const second = await createFamily();
    await expect(
      admin.query(
        `insert into app.workflow_version_dependencies
       (workspace_id,parent_version_id,node_id,target_workflow_id,target_version_id)
       values($1,$2,'foreign',$3,$4)`,
        [
          first.workspaceId,
          first.parentVersionId,
          second.childWorkflowId,
          second.childVersionId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      admin.query(
        'update app.workflow_calls set live_child_run_id=$2,child_run_id=$2 where id=$1',
        [first.callId, second.childRunId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      admin.query('delete from app.workflow_versions where id=$1', [
        first.childVersionId,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    const app = new Client({ connectionString: apiUrl });
    await app.connect();
    try {
      await app.query("select set_config('app.workspace_id',$1,false)", [
        first.workspaceId,
      ]);
      expect(
        (
          await app.query(
            'select id from app.workflow_calls where id=any($1::uuid[])',
            [[first.callId, second.callId]],
          )
        ).rows,
      ).toEqual([{ id: first.callId }]);
      expect(
        (
          await app.query(
            'select parent_version_id from app.workflow_version_dependencies where parent_version_id=any($1::uuid[])',
            [[first.parentVersionId, second.parentVersionId]],
          )
        ).rows,
      ).toEqual([{ parent_version_id: first.parentVersionId }]);
      await expect(
        app.query(
          'update app.workflow_calls set target_version_id=$2 where id=$1',
          [first.callId, second.childVersionId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await app.query("select set_config('app.workspace_id','',false)");
      expect(
        (await app.query('select id from app.workflow_calls')).rows,
      ).toEqual([]);
      expect(
        (
          await app.query(
            'select parent_version_id from app.workflow_version_dependencies',
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await app.end();
    }
  });

  it('purges call relations and publication pins before their referenced rows', async () => {
    const family = await createFamily();
    await insertBorrowedSlot(family);
    const steps = await purgeWorkspace({
      adminUrl: withDatabase(adminUrl),
      maintenanceUrl,
      workspaceId: family.workspaceId,
      pageSize: 1,
    });
    expect(steps.indexOf('workflow_run_active_admissions')).toBeLessThan(
      steps.indexOf('workflow_calls'),
    );
    expect(steps.indexOf('workflow_calls')).toBeLessThan(
      steps.indexOf('workflow_runs'),
    );
    expect(steps.indexOf('workflow_version_dependencies')).toBeLessThan(
      steps.indexOf('workflow_versions'),
    );
    expect(await callRow(family.callId)).toBeUndefined();
    expect(await runRow(family.parentRunId)).toBeUndefined();
    expect(await runRow(family.childRunId)).toBeUndefined();
    expect(
      (
        await admin.query('select status from app.workspaces where id=$1', [
          family.workspaceId,
        ])
      ).rows,
    ).toEqual([{ status: 'deleted' }]);
  });
});
