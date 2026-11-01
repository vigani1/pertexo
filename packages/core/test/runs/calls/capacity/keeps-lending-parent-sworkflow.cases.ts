import { expect, it } from 'vitest';
import {
  withTenantScopedClient,
  canonicalOutboxPayloadChecksum,
} from '@pertexo/database/primitives';

import { randomUUID } from '../../../lifecycle/retention.support.js';
import {
  admin,
  createFamily,
  insertHint,
} from '../../../lifecycle/calls/fixtures.js';
import {
  application,
  scoped,
  lend,
  takeBack,
  setStatus,
  usage,
  incomingOwner,
} from './fixture.js';

export function registerKeepsLendingParentSWorkflow(): void {
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
}
