import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';
import { readWorkspaceUsageCapacity } from '../../../src/runs/queries/usage-capacity.js';
import { canonicalOutboxPayloadChecksum } from '../../../src/outbox/events.js';
import {
  apiUrl,
  maintenanceUrl,
  randomUUID,
  waitForPostgresLock,
  withApplicationName,
} from '../../lifecycle/retention.support.js';
import {
  admin,
  createFamily,
  insertHint,
} from '../../lifecycle/calls/fixtures.js';

type Family = Awaited<ReturnType<typeof createFamily>>;
let maintenance!: Pool;
let application!: Pool;
beforeAll(() => {
  maintenance = new Pool({ connectionString: maintenanceUrl, max: 2 });
  application = new Pool({ connectionString: apiUrl, max: 1 });
});
afterAll(async () => {
  await Promise.all([maintenance.end(), application.end()]);
});
const scoped = <T>(
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
) =>
  withTenantScopedClient(maintenance, { workspaceId }, async (client) => {
    await client.query(
      "select set_config('app.workflow_concurrency_protocol','1',true)",
    );
    return work(client);
  });
async function lend(family: Family, existingOutbox?: string) {
  const outbox =
    existingOutbox ?? (await insertHint(family.workspaceId, family.childRunId));
  return scoped(
    family.workspaceId,
    async (client) =>
      (
        await client.query<{ granted: boolean }>(
          'select app.lend_workflow_run_slot($1,$2,$3,$4) granted',
          [family.workspaceId, family.callId, family.childRunId, outbox],
        )
      ).rows[0]?.granted,
  );
}
async function takeBack(family: Family) {
  const outbox = await insertHint(family.workspaceId, family.parentRunId);
  return scoped(
    family.workspaceId,
    async (client) =>
      (
        await client.query<{ returned: boolean }>(
          'select app.return_workflow_run_slot($1,$2,$3) returned',
          [family.workspaceId, family.callId, outbox],
        )
      ).rows[0]?.returned,
  );
}
async function setStatus(workspaceId: string, runId: string, status: string) {
  await withTenantScopedClient(application, { workspaceId }, async (client) => {
    await client.query(
      "select set_config('app.workflow_concurrency_protocol','1',true)",
    );
    return client.query(
      `update app.workflow_runs set status=$3::varchar,
      completed_at=case when $3::varchar='succeeded' or $3::varchar='canceled' then clock_timestamp() else null end
      where workspace_id=$1 and id=$2`,
      [workspaceId, runId, status],
    );
  });
}
const usage = async (workspaceId: string) =>
  (await readWorkspaceUsageCapacity(application, { workspaceId })).execution;
async function lowerLimit(workspaceId: string, version: number, limit: number) {
  await admin.query(
    `insert into app.workspace_execution_entitlement_versions
     (workspace_id,version,active_run_limit,queued_run_limit) values($1,$2,$3,100)`,
    [workspaceId, version, limit],
  );
  await admin.query(
    'update app.workspace_execution_entitlements set current_version=$2 where workspace_id=$1',
    [workspaceId, version],
  );
}
async function incomingOwner(family: Family) {
  return (
    await admin.query<{ workflow_run_id: string; borrowed_call_id: string }>(
      'select workflow_run_id,borrowed_call_id from app.workflow_run_active_admissions where workspace_id=$1',
      [family.workspaceId],
    )
  ).rows;
}

describe('Call workspace slot transfer', () => {
  it('lends one slot, keeps its terminal return right, and returns exactly once', async () => {
    const family = await createFamily({ childQueued: true });
    await lowerLimit(family.workspaceId, 2, 1);
    expect(await usage(family.workspaceId)).toMatchObject({
      activeCapacityConsumed: 1,
      activeRuns: 1,
    });
    expect(await lend(family)).toBe(true);
    expect(await usage(family.workspaceId)).toMatchObject({
      activeCapacityConsumed: 1,
      activeRuns: 0,
      reservedActiveSlots: 1,
    });
    expect(await lend(family)).toBe(true);
    await setStatus(family.workspaceId, family.childRunId, 'running');
    expect(await usage(family.workspaceId)).toMatchObject({
      activeCapacityConsumed: 1,
      activeRuns: 1,
      reservedActiveSlots: 0,
    });
    expect(await takeBack(family)).toBe(false);
    await setStatus(family.workspaceId, family.childRunId, 'succeeded');
    expect(await usage(family.workspaceId)).toMatchObject({
      activeCapacityConsumed: 1,
      activeRuns: 0,
      reservedActiveSlots: 1,
    });
    expect(await incomingOwner(family)).toEqual([
      { workflow_run_id: family.childRunId, borrowed_call_id: family.callId },
    ]);
    expect(await takeBack(family)).toBe(true);
    expect(await usage(family.workspaceId)).toMatchObject({
      activeCapacityConsumed: 1,
      activeRuns: 1,
      reservedActiveSlots: 0,
    });
    expect(await takeBack(family)).toBe(false);
    expect(await incomingOwner(family)).toEqual([]);
  });

  it('conserves all five default slots through handoff and a later limit reduction', async () => {
    const first = await createFamily({ childQueued: true });
    const families = [first];
    for (let index = 1; index < 5; index += 1)
      families.push(
        await createFamily({
          childQueued: true,
          workspaceId: first.workspaceId,
        }),
      );
    expect((await usage(first.workspaceId)).activeCapacityConsumed).toBe(5);
    for (const family of families) expect(await lend(family)).toBe(true);
    expect(await usage(first.workspaceId)).toMatchObject({
      activeCapacityConsumed: 5,
      activeRuns: 0,
      reservedActiveSlots: 5,
    });
    await lowerLimit(first.workspaceId, 2, 1);
    for (const family of families)
      await setStatus(first.workspaceId, family.childRunId, 'running');
    expect(await usage(first.workspaceId)).toMatchObject({
      activeCapacityConsumed: 5,
      activeRuns: 5,
      reservedActiveSlots: 0,
    });
    for (const family of families) {
      await setStatus(first.workspaceId, family.childRunId, 'succeeded');
      expect(await takeBack(family)).toBe(true);
      expect((await usage(first.workspaceId)).activeCapacityConsumed).toBe(5);
    }
  });

  it('starts a newly accepted borrower under a lower policy using an existing slot', async () => {
    const root = await createFamily({ childQueued: true });
    for (let index = 1; index < 5; index += 1)
      await createFamily({ childQueued: true, workspaceId: root.workspaceId });
    await lowerLimit(root.workspaceId, 2, 1);
    const fresh = await createFamily({
      childQueued: true,
      workspaceId: root.workspaceId,
      parentDays: 1,
    });
    await admin.query(
      'update app.workflow_calls set parent_run_id=$2,invocation_key=$3 where id=$1',
      [fresh.callId, root.parentRunId, 'fresh-call'],
    );
    const policy = await admin.query<{ execution_entitlement_version: number }>(
      'select execution_entitlement_version from app.workflow_runs where id=$1',
      [fresh.childRunId],
    );
    expect(policy.rows[0]?.execution_entitlement_version).toBe(2);
    expect(await lend({ ...fresh, parentRunId: root.parentRunId })).toBe(true);
    await setStatus(root.workspaceId, fresh.childRunId, 'running');
    expect((await usage(root.workspaceId)).activeCapacityConsumed).toBe(5);
    await setStatus(root.workspaceId, fresh.childRunId, 'succeeded');
    expect(await takeBack({ ...fresh, parentRunId: root.parentRunId })).toBe(
      true,
    );
    expect((await usage(root.workspaceId)).activeCapacityConsumed).toBe(5);
  });

  it('passes a nested loan down and returns it one direct level at a time', async () => {
    const outer = await createFamily({ childQueued: true });
    await lowerLimit(outer.workspaceId, 2, 1);
    expect(await lend(outer)).toBe(true);
    await setStatus(outer.workspaceId, outer.childRunId, 'running');
    const inner = await createFamily({
      childQueued: true,
      workspaceId: outer.workspaceId,
      parentDays: 1,
    });
    // The inner relation belongs to the existing middle run, not another live parent.
    await admin.query(
      'update app.workflow_calls set parent_run_id=$2 where id=$1',
      [inner.callId, outer.childRunId],
    );
    const nested = { ...inner, parentRunId: outer.childRunId };
    expect(await lend(nested)).toBe(true);
    expect(await incomingOwner(outer)).toEqual([
      { workflow_run_id: inner.childRunId, borrowed_call_id: inner.callId },
    ]);
    expect(await takeBack(outer)).toBe(false);
    await setStatus(outer.workspaceId, inner.childRunId, 'running');
    await setStatus(outer.workspaceId, inner.childRunId, 'succeeded');
    expect(await takeBack(nested)).toBe(true);
    expect(await incomingOwner(outer)).toEqual([
      { workflow_run_id: outer.childRunId, borrowed_call_id: outer.callId },
    ]);
    expect((await usage(outer.workspaceId)).activeCapacityConsumed).toBe(1);
    await setStatus(outer.workspaceId, outer.childRunId, 'succeeded');
    expect(await takeBack(outer)).toBe(true);
    expect(await incomingOwner(outer)).toEqual([]);
    expect((await usage(outer.workspaceId)).activeCapacityConsumed).toBe(1);
  });

  it('unwinds a canceled nested chain without releasing the slot between returns', async () => {
    const outer = await createFamily({ childQueued: true });
    expect(await lend(outer)).toBe(true);
    await setStatus(outer.workspaceId, outer.childRunId, 'running');
    const inner = await createFamily({
      childQueued: true,
      workspaceId: outer.workspaceId,
      parentDays: 1,
    });
    await admin.query(
      'update app.workflow_calls set parent_run_id=$2 where id=$1',
      [inner.callId, outer.childRunId],
    );
    const nested = { ...inner, parentRunId: outer.childRunId };
    expect(await lend(nested)).toBe(true);
    await setStatus(outer.workspaceId, inner.childRunId, 'running');
    await setStatus(outer.workspaceId, outer.parentRunId, 'canceled');
    await setStatus(outer.workspaceId, outer.childRunId, 'canceled');
    expect(await takeBack(outer)).toBe(false);
    expect((await usage(outer.workspaceId)).activeCapacityConsumed).toBe(1);
    await setStatus(outer.workspaceId, inner.childRunId, 'canceled');
    expect(await takeBack(nested)).toBe(true);
    expect(await incomingOwner(outer)).toEqual([
      { workflow_run_id: outer.childRunId, borrowed_call_id: outer.callId },
    ]);
    expect((await usage(outer.workspaceId)).activeCapacityConsumed).toBe(1);
    expect(await takeBack(outer)).toBe(true);
    expect((await usage(outer.workspaceId)).activeCapacityConsumed).toBe(0);
  });

  it('does not lend a second parallel call until the first has returned', async () => {
    const first = await createFamily({ childQueued: true });
    const other = await createFamily({
      childQueued: true,
      workspaceId: first.workspaceId,
      parentDays: 1,
    });
    await admin.query(
      'update app.workflow_calls set parent_run_id=$2,invocation_key=$3 where id=$1',
      [other.callId, first.parentRunId, 'parallel-call'],
    );
    const parallel = { ...other, parentRunId: first.parentRunId };
    expect(await lend(first)).toBe(true);
    expect(await lend(parallel)).toBe(false);
    expect((await usage(first.workspaceId)).activeCapacityConsumed).toBe(1);
    await setStatus(first.workspaceId, first.childRunId, 'succeeded');
    expect(await takeBack(first)).toBe(true);
    expect(await lend(parallel)).toBe(true);
    expect((await usage(first.workspaceId)).activeCapacityConsumed).toBe(1);
  });

  it('releases a closed root only after its terminal borrower settles', async () => {
    const family = await createFamily({ childQueued: true });
    expect(await lend(family)).toBe(true);
    await setStatus(family.workspaceId, family.childRunId, 'running');
    await setStatus(family.workspaceId, family.parentRunId, 'canceled');
    expect(await takeBack(family)).toBe(false);
    expect((await usage(family.workspaceId)).activeCapacityConsumed).toBe(1);
    await setStatus(family.workspaceId, family.childRunId, 'canceled');
    expect(await takeBack(family)).toBe(true);
    expect((await usage(family.workspaceId)).activeCapacityConsumed).toBe(0);
  });

  it('keeps a lending parent’s workflow claim and refuses a full target without a loan', async () => {
    const family = await createFamily({ childQueued: true });
    const workflow = (
      await admin.query<{ workflow_id: string }>(
        'select workflow_id from app.workflow_runs where id=$1',
        [family.parentRunId],
      )
    ).rows[0]?.workflow_id;
    const blocker = randomUUID();
    await admin.query(
      "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','queued')",
      [
        blocker,
        family.workspaceId,
        family.childWorkflowId,
        family.childVersionId,
      ],
    );
    await setStatus(family.workspaceId, blocker, 'running');
    await admin.query(
      'insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit) values($1,$2,1)',
      [family.workspaceId, family.childWorkflowId],
    );
    expect(await lend(family)).toBe(false);
    expect(await incomingOwner(family)).toEqual([]);
    await setStatus(family.workspaceId, blocker, 'succeeded');
    expect(await lend(family)).toBe(true);
    expect(
      (
        await scoped(family.workspaceId, (client) =>
          client.query<{ active_runs: number }>(
            'select active_runs from app.workflow_run_slot_counts($1,$2)',
            [family.workspaceId, workflow],
          ),
        )
      ).rows,
    ).toEqual([{ active_runs: 1 }]);
  });

  it('does not let ordinary dispatcher or receipt release erase a borrowed reservation', async () => {
    const family = await createFamily({ childQueued: true });
    const outbox = await insertHint(family.workspaceId, family.childRunId);
    expect(await lend(family, outbox)).toBe(true);
    await scoped(family.workspaceId, async (client) => {
      expect(
        (
          await client.query<{ released: boolean }>(
            'select app.release_dispatcher_workflow_run_active_admission($1,$2) released',
            [family.workspaceId, outbox],
          )
        ).rows[0]?.released,
      ).toBe(false);
    });
    // The app-role receipt owner has the ordinary release grant, not transfer authority.
    await withTenantScopedClient(
      application,
      { workspaceId: family.workspaceId },
      async (client) => {
        expect(
          (
            await client.query<{ released: boolean }>(
              'select app.release_workflow_run_active_admission($1,$2) released',
              [family.workspaceId, outbox],
            )
          ).rows[0]?.released,
        ).toBe(false);
      },
    );
    await expect(
      withTenantScopedClient(
        application,
        { workspaceId: family.workspaceId },
        (client) =>
          client.query('select app.lend_workflow_run_slot($1,$2,$3,$4)', [
            family.workspaceId,
            family.callId,
            family.childRunId,
            outbox,
          ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await incomingOwner(family)).toEqual([
      { workflow_run_id: family.childRunId, borrowed_call_id: family.callId },
    ]);
  });
  it.each(['published', 'failed'] as const)(
    'recovers a %s child hint without dropping or duplicating the borrowed slot',
    async (delivery) => {
      const family = await createFamily({ childQueued: true });
      const original = await insertHint(family.workspaceId, family.childRunId);
      expect(await lend(family, original)).toBe(true);
      await admin.query(
        delivery === 'published'
          ? 'update app.outbox_events set published_at=clock_timestamp() where id=$1'
          : "update app.outbox_events set failed_at=clock_timestamp(),last_error_code='publish.failed' where id=$1",
        [original],
      );
      await admin.query(
        "update app.workflow_run_active_admissions set recover_after=clock_timestamp()-interval '1 minute' where workspace_id=$1",
        [family.workspaceId],
      );
      await scoped(family.workspaceId, async (client) => {
        expect(
          (
            await client.query<{ recovered: number }>(
              'select app.recover_due_workflow_run_active_admissions(100) recovered',
            )
          ).rows[0]?.recovered,
        ).toBe(1);
      });
      const rows = await admin.query<{
        outbox_event_id: string;
        borrowed_call_id: string;
        recover_after: Date;
      }>(
        'select outbox_event_id,borrowed_call_id,recover_after from app.workflow_run_active_admissions where workspace_id=$1',
        [family.workspaceId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.outbox_event_id).not.toBe(original);
      expect(rows.rows[0]?.borrowed_call_id).toBe(family.callId);
      expect(rows.rows[0]?.recover_after).toBeInstanceOf(Date);
      const replacement = await admin.query<{
        payload: Parameters<typeof canonicalOutboxPayloadChecksum>[0];
        payload_checksum: string;
      }>('select payload,payload_checksum from app.outbox_events where id=$1', [
        rows.rows[0]?.outbox_event_id,
      ]);
      expect(replacement.rows[0]?.payload_checksum).toBe(
        canonicalOutboxPayloadChecksum(replacement.rows[0]?.payload ?? {}),
      );
      expect((await usage(family.workspaceId)).activeCapacityConsumed).toBe(1);
      await setStatus(family.workspaceId, family.childRunId, 'running');
      expect(await incomingOwner(family)).toEqual([
        { workflow_run_id: family.childRunId, borrowed_call_id: family.callId },
      ]);
    },
  );

  it('recovers a terminal borrower’s parent hint until the direct slot returns', async () => {
    const family = await createFamily({ childQueued: true });
    expect(await lend(family)).toBe(true);
    await setStatus(family.workspaceId, family.childRunId, 'running');
    await setStatus(family.workspaceId, family.childRunId, 'succeeded');
    await admin.query(
      "update app.workflow_run_active_admissions set recover_after=clock_timestamp()-interval '1 minute' where workspace_id=$1",
      [family.workspaceId],
    );
    await scoped(family.workspaceId, async (client) => {
      expect(
        (
          await client.query<{ recovered: number }>(
            'select app.recover_due_workflow_run_active_admissions(100) recovered',
          )
        ).rows[0]?.recovered,
      ).toBe(1);
    });
    const hints = await admin.query<{
      payload: Parameters<typeof canonicalOutboxPayloadChecksum>[0];
      payload_checksum: string;
    }>(
      "select payload,payload_checksum from app.outbox_events where workspace_id=$1 and aggregate_id=$2 and last_error_code='publish.delivery_recovery'",
      [family.workspaceId, family.parentRunId],
    );
    expect(hints.rows).toHaveLength(1);
    expect(hints.rows[0]?.payload_checksum).toBe(
      canonicalOutboxPayloadChecksum(hints.rows[0]?.payload ?? {}),
    );
    expect((await usage(family.workspaceId)).activeCapacityConsumed).toBe(1);
    expect(await takeBack(family)).toBe(true);
    expect(await incomingOwner(family)).toEqual([]);
  });
  it.each(['running', 'unpublished'] as const)(
    'moves a %s borrower behind another due terminal return in a bounded poll',
    async (state) => {
      const busy = await createFamily({ childQueued: true });
      const finished = await createFamily({ childQueued: true });
      expect(await lend(busy)).toBe(true);
      expect(await lend(finished)).toBe(true);
      if (state === 'running')
        await setStatus(busy.workspaceId, busy.childRunId, 'running');
      await setStatus(finished.workspaceId, finished.childRunId, 'succeeded');
      await admin.query(
        "update app.workflow_run_active_admissions set recover_after=clock_timestamp()-interval '2 minutes' where workspace_id=$1",
        [busy.workspaceId],
      );
      await admin.query(
        "update app.workflow_run_active_admissions set recover_after=clock_timestamp()-interval '1 minute' where workspace_id=$1",
        [finished.workspaceId],
      );
      const poll = () =>
        scoped(
          busy.workspaceId,
          async (client) =>
            (
              await client.query<{ recovered: number }>(
                'select app.recover_due_workflow_run_active_admissions(1) recovered',
              )
            ).rows[0]?.recovered,
        );
      expect(await poll()).toBe(0);
      expect(await poll()).toBe(1);
      expect((await usage(busy.workspaceId)).activeCapacityConsumed).toBe(1);
      expect((await usage(finished.workspaceId)).activeCapacityConsumed).toBe(
        1,
      );
      expect(await takeBack(finished)).toBe(true);
    },
  );

  it('returns capacity without acquiring a lock on the existing terminal child', async () => {
    const family = await createFamily({ childQueued: true });
    expect(await lend(family)).toBe(true);
    await setStatus(family.workspaceId, family.childRunId, 'succeeded');
    const hint = await insertHint(family.workspaceId, family.parentRunId);
    await admin.query('begin');
    try {
      await admin.query(
        'select id from app.workflow_runs where id=$1 for no key update',
        [family.childRunId],
      );
      expect(
        await scoped(family.workspaceId, async (client) => {
          await client.query("set local statement_timeout='2000ms'");
          return (
            await client.query<{ returned: boolean }>(
              'select app.return_workflow_run_slot($1,$2,$3) returned',
              [family.workspaceId, family.callId, hint],
            )
          ).rows[0]?.returned;
        }),
      ).toBe(true);
    } finally {
      await admin.query('rollback');
    }
    expect((await usage(family.workspaceId)).activeCapacityConsumed).toBe(1);
  });

  it('waits for the parent writer while the child can settle independently', async () => {
    const family = await createFamily({ childQueued: true });
    expect(await lend(family)).toBe(true);
    await setStatus(family.workspaceId, family.childRunId, 'running');
    const hint = await insertHint(family.workspaceId, family.parentRunId);
    const name = `call-return-${randomUUID()}`;
    const competing = new Pool({
      connectionString: withApplicationName(maintenanceUrl, name),
      max: 1,
    });
    await admin.query('begin');
    let returning: Promise<boolean | undefined> | undefined;
    try {
      await admin.query(
        'select id from app.workflow_runs where id=$1 for no key update',
        [family.parentRunId],
      );
      returning = withTenantScopedClient(
        competing,
        { workspaceId: family.workspaceId },
        async (client) =>
          (
            await client.query<{ returned: boolean }>(
              'select app.return_workflow_run_slot($1,$2,$3) returned',
              [family.workspaceId, family.callId, hint],
            )
          ).rows[0]?.returned,
      );
      await waitForPostgresLock(name);
      await setStatus(family.workspaceId, family.childRunId, 'succeeded');
      await admin.query('commit');
      expect(await returning).toBe(true);
    } finally {
      await admin.query('rollback');
      await returning;
      await competing.end();
    }
    expect((await usage(family.workspaceId)).activeCapacityConsumed).toBe(1);
  });
});
