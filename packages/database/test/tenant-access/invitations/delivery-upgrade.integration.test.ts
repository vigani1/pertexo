import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../../platform/migrations/upgrade-fixture.js';

it('upgrades only acknowledged unknown invitation deliveries in 0089, preserves live controls and restores forced row security', async () => {
  await withUpgradeDatabase(88, async ({ admin, upgrade }) => {
    const { workspaceId, ownerId } = await seedWorkflow(admin);
    const ids: string[] = [];
    for (const state of [
      'acknowledged-unknown',
      'in-flight-unknown',
      'queued',
      'submitted',
      'wrong-checksum',
    ]) {
      const invitationId = randomUUID(),
        attemptId = randomUUID(),
        eventId = randomUUID();
      ids.push(invitationId);
      await admin.query(
        `insert into app.workspace_invitations(id,workspace_id,recipient_email,normalized_email,role,token_digest,created_by,expires_at,delivery_status)
        values($1,$2,$3,$3,'viewer',repeat('a',64),$4,clock_timestamp()+interval '7 days',$5)`,
        [
          invitationId,
          workspaceId,
          `${invitationId}@example.test`,
          ownerId,
          state === 'submitted' ? 'submitted' : 'queued',
        ],
      );
      await admin.query(
        `insert into app.workspace_invitation_delivery_attempts(id,workspace_id,invitation_id,invitation_revision,status,workspace_name,token_ciphertext,token_nonce,token_tag,token_key_version)
        values($1,$2,$3,1,$4,'Retained workspace','sealed','nonce','tag','v1')`,
        [
          attemptId,
          workspaceId,
          invitationId,
          (
            { queued: 'queued', submitted: 'submitted' } as Record<
              string,
              string
            >
          )[state] ?? 'unknown',
        ],
      );
      await admin.query(
        `insert into app.outbox_events(id,workspace_id,aggregate_type,aggregate_id,job_name,payload,payload_checksum)
        values($1,$2,'workspace-invitation',$3,'deliver-workspace-invitation',$4,repeat('a',64))`,
        [
          eventId,
          workspaceId,
          invitationId,
          JSON.stringify({ deliveryAttemptId: attemptId }),
        ],
      );
      if (['acknowledged-unknown', 'wrong-checksum'].includes(state))
        await admin.query(
          `insert into app.inbox_receipts(consumer_name,message_id,workspace_id,payload_checksum,completed_at)
          values('workspace-invitation',$1,$2,repeat($3,64),clock_timestamp())`,
          [eventId, workspaceId, state === 'wrong-checksum' ? 'b' : 'a'],
        );
    }
    const snapshot = async () =>
      (
        await admin.query<Record<string, unknown>>(
          `select i.id,i.delivery_status,a.status,a.token_ciphertext,a.failure_code from app.workspace_invitations i
      join app.workspace_invitation_delivery_attempts a on a.invitation_id=i.id where i.id=any($1::uuid[]) order by array_position($1::uuid[],i.id)`,
          [ids],
        )
      ).rows;
    const before = await snapshot();
    expect(await upgrade(89)).toEqual([
      '0089_expose_unconfirmed_invitation_delivery.sql',
      '0090_bound_trigger_failure_evidence.sql',
    ]);
    expect(await snapshot()).toEqual([
      {
        ...before[0],
        delivery_status: 'unknown',
        token_ciphertext: null,
        failure_code: 'delivery.outcome_unknown',
      },
      ...before.slice(1),
    ]);
    expect(
      (
        await admin.query(`select relname,relrowsecurity,relforcerowsecurity from pg_class
      where oid in ('app.inbox_receipts'::regclass,'app.outbox_events'::regclass) order by relname`)
      ).rows,
    ).toEqual([
      {
        relname: 'inbox_receipts',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: 'outbox_events',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
    expect(await upgrade(89)).toEqual([]);
  });
});
