import { expect, it } from 'vitest';
import {
  randomUUID,
  retention,
  userId,
  workspaceId,
} from '../retention.support.js';
import { digest, asOwner, insertReplacement } from './fixture.js';

export function registerExpiresUnansweredInvitationsRemovesEnded(): void {
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

  it('keeps cyclic claims while seeking past them to fill a cleanup page', async () => {
    const cycle = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ];
    const ended = [
      'ffffffff-ffff-4fff-8fff-fffffffffff1',
      'ffffffff-ffff-4fff-8fff-fffffffffff2',
    ];
    const ids = [...cycle, ...ended];
    try {
      for (const [index, id] of ids.entries()) {
        const next = index < 2 ? cycle[1 - index] : randomUUID();
        await insertReplacement(id, next ?? randomUUID());
      }
      const pass = await retention.enforce();
      expect(pass.removed.invitation_replacement_claims).toBe(2);
      expect(
        (
          await asOwner<{ prior_intent_id: string }>(
            `select prior_intent_id from app.workspace_invitation_binding_replacement_claims where prior_intent_id=any($1::uuid[]) order by prior_intent_id`,
            [ids],
          )
        ).rows.map((row) => row.prior_intent_id),
      ).toEqual(cycle);
    } finally {
      await asOwner(
        'delete from app.workspace_invitation_binding_replacement_claims where prior_intent_id=any($1::uuid[])',
        [ids],
      );
    }
  });
}
