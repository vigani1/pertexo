import { createHash } from 'node:crypto';

import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  owner,
  randomUUID,
  retention,
  userId,
  workspaceId,
} from './retention.support.js';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

async function asOwner<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
) {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await owner.query<Row>(text, [...values]);
    await owner.query('commit');
    return result;
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

describe('transient data retention', () => {
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

  it('expires unanswered invitations and removes ended acceptances and their claims', async () => {
    const invitationId = randomUUID();
    const attemptId = randomUUID();
    const expiredIntentId = randomUUID();
    const abandonedIntentId = randomUUID();
    const priorIntentId = randomUUID();
    await asOwner(
      `insert into app.workspace_invitations
        (id,workspace_id,recipient_email,normalized_email,role,status,revision,
         token_digest,delivery_status,created_by,expires_at)
       values($1,$2,'expired-invite@example.test','expired-invite@example.test',
         'viewer','pending',1,$3,'queued',$4,clock_timestamp()-interval '1 day')`,
      [invitationId, workspaceId, digest(invitationId), userId],
    );
    await asOwner(
      `insert into app.workspace_invitation_delivery_attempts
        (id,workspace_id,invitation_id,invitation_revision,status,
         token_ciphertext,token_nonce,token_tag,token_key_version,workspace_name)
       values($1,$2,$3,1,'unknown','sealed','nonce','tag','v1','Retention workspace')`,
      [attemptId, workspaceId, invitationId],
    );
    await asOwner(
      `insert into app.workspace_invitation_acceptance_intents
        (id,workspace_id,invitation_id,invitation_revision,binding_digest,
         csrf_digest,status,expires_at,abandoned_at)
       values
        ($1,$3,$4,1,$5,$6,'pending',clock_timestamp()-interval '1 hour',null),
        ($2,$3,$4,1,$7,$8,'abandoned',clock_timestamp()+interval '1 hour',clock_timestamp())`,
      [
        expiredIntentId,
        abandonedIntentId,
        workspaceId,
        invitationId,
        digest(expiredIntentId),
        digest(`csrf:${expiredIntentId}`),
        digest(abandonedIntentId),
        digest(`csrf:${abandonedIntentId}`),
      ],
    );
    await asOwner(
      `insert into app.workspace_invitation_binding_replacement_claims
        (prior_workspace_id,prior_intent_id,prior_binding_digest,
         successor_workspace_id,successor_intent_id,successor_invitation_id,
         successor_invitation_revision,successor_binding_digest,
         successor_csrf_digest)
       values($1,$2,$3,$1,$4,$5,1,$6,$7)`,
      [
        workspaceId,
        priorIntentId,
        digest(priorIntentId),
        abandonedIntentId,
        invitationId,
        digest(abandonedIntentId),
        digest(`csrf:${abandonedIntentId}`),
      ],
    );

    const { removed } = await retention.enforce();
    expect(removed.invitation_expiry).toBe(1);
    expect(removed.invitation_acceptance_intents).toBe(2);
    expect(removed.invitation_replacement_claims).toBe(1);
    const state = await asOwner<{
      delivery_status: string;
      invitation_status: string;
      sealed: boolean;
      attempt_status: string;
      claim_count: number;
      intent_count: number;
    }>(
      `select invitation.status invitation_status,
              invitation.delivery_status,
              attempt.status attempt_status,
              attempt.token_ciphertext is not null sealed,
              (select count(*)::integer
                 from app.workspace_invitation_acceptance_intents intent
                where intent.invitation_id=invitation.id) intent_count,
              (select count(*)::integer
                 from app.workspace_invitation_binding_replacement_claims claim
                where claim.successor_invitation_id=invitation.id) claim_count
         from app.workspace_invitations invitation
         join app.workspace_invitation_delivery_attempts attempt
           on attempt.invitation_id=invitation.id
        where invitation.id=$1`,
      [invitationId],
    );
    expect(state.rows[0]).toEqual({
      invitation_status: 'expired',
      delivery_status: 'canceled',
      attempt_status: 'unknown',
      claim_count: 0,
      sealed: false,
      intent_count: 0,
    });
  });

  it('keeps a claim while an acceptance further down its chain is live', async () => {
    const invitationId = randomUUID();
    const intentA = randomUUID();
    const intentB = randomUUID();
    const intentC = randomUUID();
    const bindingA = digest(`binding:${intentA}`);
    const bindingB = digest(`binding:${intentB}`);
    const bindingC = digest(`binding:${intentC}`);
    await asOwner(
      `insert into app.workspace_invitations
        (id,workspace_id,recipient_email,normalized_email,role,status,revision,
         token_digest,delivery_status,created_by,expires_at)
       values($1,$2,$3,$3,'viewer','pending',1,$4,'submitted',$5,
         clock_timestamp()+interval '1 day')`,
      [
        invitationId,
        workspaceId,
        `${invitationId}@example.test`,
        digest(invitationId),
        userId,
      ],
    );
    await asOwner(
      `insert into app.workspace_invitation_acceptance_intents
        (id,workspace_id,invitation_id,invitation_revision,binding_digest,
         csrf_digest,status,expires_at)
       values($1,$2,$3,1,$4,$5,'pending',clock_timestamp()+interval '10 minutes')`,
      [intentC, workspaceId, invitationId, bindingC, digest(`csrf:${intentC}`)],
    );
    await asOwner(
      `insert into app.workspace_invitation_binding_replacement_claims
        (prior_workspace_id,prior_intent_id,prior_binding_digest,
         successor_workspace_id,successor_intent_id,successor_invitation_id,
         successor_invitation_revision,successor_binding_digest,
         successor_csrf_digest)
       values
        ($1,$2,$3,$1,$4,$6,1,$5,$7),
        ($1,$4,$5,$1,$8,$6,1,$9,$10)`,
      [
        workspaceId,
        intentA,
        bindingA,
        intentB,
        bindingB,
        invitationId,
        digest(`csrf:${intentB}`),
        intentC,
        bindingC,
        digest(`csrf:${intentC}`),
      ],
    );

    const retained = await retention.enforce();
    expect(retained.removed.invitation_replacement_claims).toBe(0);
    await expect(
      asOwner<{ count: number }>(
        `select count(*)::integer count
           from app.workspace_invitation_binding_replacement_claims
          where prior_intent_id in ($1,$2)`,
        [intentA, intentB],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });

    await asOwner(
      `update app.workspace_invitation_acceptance_intents
          set status='superseded',updated_at=clock_timestamp()
        where id=$1`,
      [intentC],
    );
    const reaped = await retention.enforce();
    expect(reaped.removed.invitation_replacement_claims).toBe(2);
    await expect(
      asOwner<{ count: number }>(
        `select count(*)::integer count
           from app.workspace_invitation_binding_replacement_claims
          where prior_intent_id in ($1,$2)`,
        [intentA, intentB],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
