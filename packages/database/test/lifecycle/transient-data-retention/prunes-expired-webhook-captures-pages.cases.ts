import { expect, it } from 'vitest';
import {
  randomUUID,
  retention,
  userId,
  workspaceId,
} from '../retention.support.js';
import { digest, asOwner } from './fixture.js';

export function registerPrunesExpiredWebhookCapturesPages(): void {
  it('prunes expired webhook captures in pages and leaves a live listener', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const active = randomUUID();
    for (const id of [...ids, active]) {
      const workflow = randomUUID();
      await asOwner(
        'insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,$3,$4)',
        [workflow, workspaceId, 'Capture retention', userId],
      );
      await asOwner(
        `insert into app.webhook_test_events(id,workspace_id,workflow_id,node_id,created_by,endpoint_key_hash,binding,authentication,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,output_ref,received_at,created_at,expires_at) values($1,$2,$3,'webhook',$4,$5,'binding','{"mode":"signed","allowedOrigins":[]}','fixture','data-key','sealed','nonce','tag','{"kind":"inline","value":{"sample":true}}',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day',clock_timestamp()+case when $6 then interval '120 seconds' else interval '-1 second' end)`,
        [id, workspaceId, workflow, userId, digest(id), id === active],
      );
    }
    expect((await retention.enforce()).removed.webhook_test_events).toBe(2);
    expect((await retention.enforce()).removed.webhook_test_events).toBe(1);
    expect(
      (
        await asOwner<{ id: string }>(
          'select id from app.webhook_test_events where id=any($1::uuid[])',
          [[...ids, active]],
        )
      ).rows,
    ).toEqual([{ id: active }]);
    await asOwner('delete from app.webhook_test_events where id=$1', [active]);
  });

  it('prunes expired method-link attempts in bounded pages', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries())
      await asOwner(
        `insert into app.auth_method_link_attempts
          (id,user_id,session_id,browser_digest,source_provider,
           target_provider,phase,expires_at,created_at)
         values ($1,$2,$3,decode($4,'hex'),'credential','google',
                 'abandoned',clock_timestamp()-interval '39 days',
                 clock_timestamp()-interval '40 days')`,
        [id, userId, randomUUID(), digest(`old-link-${String(index)}`)],
      );
    const first = await retention.enforce();
    expect(first.removed.auth_method_link_attempts).toBe(2);
    const second = await retention.enforce();
    expect(second.removed.auth_method_link_attempts).toBe(1);
    const remaining = await asOwner<{ count: number }>(
      `select count(*)::integer count from app.auth_method_link_attempts
        where id=any($1::uuid[])`,
      [ids],
    );
    expect(remaining.rows).toEqual([{ count: 0 }]);
  });

  it('pages expired proof and 365-day security-audit cleanup', async () => {
    const proofIds = [randomUUID(), randomUUID(), randomUUID()];
    const auditIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of proofIds.entries())
      await asOwner(
        `insert into app.auth_email_proofs
          (id,token_digest,user_id,purpose,email,created_at,expires_at)
         values($1,decode($2,'hex'),$3,'initial_verification',$4,
                clock_timestamp()-interval '40 days',
                clock_timestamp()-interval '39 days')`,
        [
          id,
          digest(`expired-proof-${String(index)}`),
          userId,
          `${userId}@example.test`,
        ],
      );
    for (const id of auditIds)
      await asOwner(
        `insert into app.identity_security_audit_facts
          (id,user_id,event_type,occurred_at)
         values($1,$2,'email.initial_verified',
                clock_timestamp()-interval '366 days')`,
        [id, userId],
      );
    const first = await retention.enforce();
    expect(first.removed.auth_email_proofs).toBe(2);
    expect(first.removed.identity_security_audit_facts).toBe(2);
    const second = await retention.enforce();
    expect(second.removed.auth_email_proofs).toBe(1);
    expect(second.removed.identity_security_audit_facts).toBe(1);
    expect(
      (
        await asOwner<{ count: number }>(
          `select (select count(*)::integer from app.auth_email_proofs
                    where id=any($1::uuid[]))
                + (select count(*)::integer from app.identity_security_audit_facts
                    where id=any($2::uuid[])) count`,
          [proofIds, auditIds],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it('pages completed expired replay records and permits key reuse', async () => {
    const keyHashes = [
      'expired-1',
      'expired-2',
      'expired-3',
      'in-progress',
    ].map(digest);
    for (const [index, keyHash] of keyHashes.entries()) {
      await asOwner(
        `insert into app.idempotency_records
          (id,workspace_id,operation,scope,key_hash,request_hash,status,
           resource_id,result_ref,created_at,expires_at)
         values($1,$2,'connection.update','connection:test',$3,$4,$5,$6,
           '{}'::jsonb,clock_timestamp()-interval '2 days',
           clock_timestamp()-interval '1 day')`,
        [
          randomUUID(),
          workspaceId,
          keyHash,
          digest(`request-${String(index)}`),
          index === 3 ? 'in_progress' : 'completed',
          randomUUID(),
        ],
      );
    }

    const first = await retention.enforce();
    expect(first.removed.idempotency_records).toBe(2);
    const second = await retention.enforce();
    expect(second.removed.idempotency_records).toBe(1);

    const remaining = await asOwner(
      `select status,count(*)::integer count
       from app.idempotency_records
       where workspace_id=$1 and operation='connection.update'
       group by status`,
      [workspaceId],
    );
    expect(remaining.rows).toEqual([{ status: 'in_progress', count: 1 }]);

    await expect(
      asOwner(
        `insert into app.idempotency_records
          (id,workspace_id,operation,scope,key_hash,request_hash,status,
           resource_id,result_ref)
         values($1,$2,'connection.update','connection:test',$3,$4,
           'completed',$5,'{}'::jsonb)`,
        [
          randomUUID(),
          workspaceId,
          keyHashes[0],
          digest('replacement-request'),
          randomUUID(),
        ],
      ),
    ).resolves.toBeDefined();
  });

  it('keeps active sessions and removes a session 30 days after it ends', async () => {
    const activeId = randomUUID();
    const expiredId = randomUUID();
    await asOwner(
      `insert into app.auth_sessions
        (id,user_id,token,created_at,updated_at,expires_at)
       values
        ($1,$3,$4,clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day'),
        ($2,$3,$5,clock_timestamp()-interval '40 days',clock_timestamp()-interval '40 days',clock_timestamp()-interval '31 days')`,
      [activeId, expiredId, userId, `token-${activeId}`, `token-${expiredId}`],
    );

    const { removed } = await retention.enforce();
    expect(removed.auth_sessions).toBe(1);
    const retained = await asOwner<{ id: string }>(
      `select id from app.auth_sessions where id=any($1::uuid[]) order by id`,
      [[activeId, expiredId]],
    );
    expect(retained.rows).toEqual([{ id: activeId }]);
  });

  it('minimizes terminal invitation recipient data after 90 days', async () => {
    const invitationId = randomUUID();
    await asOwner(
      `insert into app.workspace_invitations
        (id,workspace_id,recipient_email,normalized_email,role,status,revision,
         token_digest,delivery_status,created_by,accepted_by,expires_at,
         accepted_at,created_at,updated_at)
       values($1,$2,'retained-recipient@example.test','retained-recipient@example.test',
         'viewer','accepted',1,$3,'canceled',$4,$4,
         clock_timestamp()-interval '100 days',clock_timestamp()-interval '100 days',
         clock_timestamp()-interval '100 days',clock_timestamp()-interval '100 days')`,
      [invitationId, workspaceId, digest(invitationId), userId],
    );
    const { removed } = await retention.enforce();
    expect(removed.invitation_recipients).toBe(1);
    const minimized = await asOwner<{ recipient_email: string }>(
      `select recipient_email from app.workspace_invitations
        where workspace_id=$1 and id=$2`,
      [workspaceId, invitationId],
    );
    expect(minimized.rows[0]).toEqual({
      recipient_email: `minimized+${invitationId}@invalid.pertexo`,
    });
  });
}
