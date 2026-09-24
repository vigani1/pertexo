import { createHash } from 'node:crypto';

import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  owner,
  randomUUID,
  retention,
  userId,
  workspaceId,
} from './support/retention.integration.support.js';

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

async function createClaimScanPurgeJob() {
  const scanWorkspaceId = randomUUID();
  const purgeJobId = randomUUID();
  await asOwner(
    `insert into app.workspaces(id,name,slug,created_by)
     values($1,'Claim scan transition',$2,$3)`,
    [scanWorkspaceId, `claim-scan-${scanWorkspaceId}`, userId],
  );
  await asOwner(
    `insert into app.workspace_purge_jobs(
       id,workspace_id,command_id,actor_ref,reason,occurred_at
     ) values($1,$2,$3,'maintenance:test','claim scan transition',clock_timestamp())`,
    [purgeJobId, scanWorkspaceId, randomUUID()],
  );
  return { purgeJobId, scanWorkspaceId };
}

async function insertReapableClaim(
  scanWorkspaceId: string,
  intentId = randomUUID(),
) {
  await asOwner(
    `insert into app.workspace_invitation_binding_replacement_claims
      (prior_workspace_id,prior_intent_id,prior_binding_digest,
       successor_workspace_id,successor_intent_id,successor_invitation_id,
       successor_invitation_revision,successor_binding_digest,
       successor_csrf_digest)
     values($1,$2,$3,$1,$4,$5,1,$6,$7)`,
    [
      scanWorkspaceId,
      intentId,
      digest(`prior:${intentId}`),
      randomUUID(),
      randomUUID(),
      digest(`successor:${intentId}`),
      digest(`csrf:${intentId}`),
    ],
  );
  return intentId;
}

interface ClaimScanState {
  cursor_updated_at: string | null;
  high_water_updated_at: string | null;
  cycle_completed: boolean;
}

async function readClaimScanState(purgeJobId: string) {
  const result = await asOwner<ClaimScanState>(
    `select cursor_updated_at::text,high_water_updated_at::text,cycle_completed
       from app.workspace_invitation_claim_cleanup_cursors
      where scan_kind='workspace_purge' and scan_id=$1`,
    [purgeJobId],
  );
  return result.rows[0];
}

function expectValidClaimScanBounds(state: ClaimScanState | undefined) {
  expect(state).toBeDefined();
  if (state?.cursor_updated_at !== null)
    expect(state?.high_water_updated_at).not.toBeNull();
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
    const first = await retention.reapTransientData();
    expect(first.authenticationLinkAttemptsDeleted).toBe(2);
    const second = await retention.reapTransientData();
    expect(second.authenticationLinkAttemptsDeleted).toBe(1);
    const remaining = await asOwner<{ count: number }>(
      `select count(*)::integer count from app.auth_method_link_attempts
        where id=any($1::uuid[])`,
      [ids],
    );
    expect(remaining.rows).toEqual([{ count: 0 }]);
  });

  it('prunes expired legacy-migration attempts without erasing durable mapping facts', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries())
      await asOwner(
        `insert into app.auth_legacy_method_migration_attempts
          (id,browser_digest,oidc_state_digest,target_provider,expires_at,created_at)
         values($1,decode($2,'hex'),decode($3,'hex'),'google',
                clock_timestamp()-interval '39 days',
                clock_timestamp()-interval '40 days')`,
        [id, digest(`legacy-browser-${String(index)}`), digest(`legacy-state-${String(index)}`)],
      );
    const first = await retention.reapTransientData();
    expect(first.authenticationLegacyAttemptsDeleted).toBe(2);
    const second = await retention.reapTransientData();
    expect(second.authenticationLegacyAttemptsDeleted).toBe(1);
    const remaining = await asOwner<{ count: number }>(
      `select count(*)::integer count from app.auth_legacy_method_migration_attempts
        where id=any($1::uuid[])`,
      [ids],
    );
    expect(remaining.rows).toEqual([{ count: 0 }]);
  });

  it('bounds owned proof and 365-day security-audit cleanup while preserving holds', async () => {
    const proofIds = [randomUUID(), randomUUID(), randomUUID()];
    const auditIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
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
    for (const [index, id] of auditIds.entries())
      await asOwner(
        `insert into app.identity_security_audit_facts
          (id,user_id,event_type,occurred_at,legal_hold_until)
         values($1,$2,'email.initial_verified',
                clock_timestamp()-interval '366 days',$3)`,
        [id, userId, index === 0 ? new Date(Date.now() + 86_400_000) : null],
      );
    const first = await retention.reapTransientData();
    expect(first.authenticationProofsDeleted).toBe(2);
    expect(first.identitySecurityAuditDeleted).toBe(2);
    const second = await retention.reapTransientData();
    expect(second.authenticationProofsDeleted).toBe(1);
    expect(second.identitySecurityAuditDeleted).toBe(1);
    const held = await asOwner<{ id: string }>(
      `select id from app.identity_security_audit_facts
        where id=any($1::uuid[])`,
      [auditIds],
    );
    expect(held.rows).toEqual([{ id: auditIds[0] }]);
    await asOwner(
      `update app.identity_security_audit_facts
          set legal_hold_until=clock_timestamp()-interval '1 second'
        where id=$1`,
      [auditIds[0]],
    );
    const released = await retention.reapTransientData();
    expect(released.identitySecurityAuditDeleted).toBe(1);
    expect(
      (
        await asOwner<{ count: number }>(
          `select count(*)::integer count from app.auth_email_proofs
        where id=any($1::uuid[])`,
          [proofIds],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it('resumes a completed purge scan atomically and defers mid-cycle arrivals', async () => {
    const { purgeJobId, scanWorkspaceId } = await createClaimScanPurgeJob();
    const initialIntentId = await insertReapableClaim(scanWorkspaceId);

    await expect(
      asOwner(
        `select * from app.scan_workspace_invitation_replacement_claims(
          'workspace_purge',$1,$2,2)`,
        [purgeJobId, scanWorkspaceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ cycle_completed: true, deleted_count: 1, scanned_count: 1 }],
    });
    const completedState = await readClaimScanState(purgeJobId);
    expectValidClaimScanBounds(completedState);
    expect(completedState?.cycle_completed).toBe(true);

    const nextCycleIntentIds = await Promise.all([
      insertReapableClaim(scanWorkspaceId),
      insertReapableClaim(scanWorkspaceId),
      insertReapableClaim(scanWorkspaceId),
    ]);
    await expect(
      asOwner(
        `select * from app.scan_workspace_invitation_replacement_claims(
          'workspace_purge',$1,$2,2)`,
        [purgeJobId, scanWorkspaceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ cycle_completed: false, deleted_count: 2, scanned_count: 2 }],
    });
    const runningState = await readClaimScanState(purgeJobId);
    expectValidClaimScanBounds(runningState);
    expect(runningState?.cycle_completed).toBe(false);
    expect(
      (runningState?.cursor_updated_at ?? '') >
        (completedState?.high_water_updated_at ?? ''),
    ).toBe(true);
    expect(
      (runningState?.cursor_updated_at ?? '') <=
        (runningState?.high_water_updated_at ?? ''),
    ).toBe(true);
    expect(runningState?.high_water_updated_at).not.toEqual(
      completedState?.high_water_updated_at,
    );

    const midCycleIntentId = await insertReapableClaim(scanWorkspaceId);
    await expect(
      asOwner(
        `select * from app.scan_workspace_invitation_replacement_claims(
          'workspace_purge',$1,$2,2)`,
        [purgeJobId, scanWorkspaceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ cycle_completed: true, deleted_count: 1, scanned_count: 1 }],
    });
    const firstClaimState = await readClaimScanState(purgeJobId);
    expectValidClaimScanBounds(firstClaimState);
    expect(firstClaimState).toMatchObject({ cycle_completed: true });
    expect(firstClaimState?.cursor_updated_at).toEqual(
      firstClaimState?.high_water_updated_at,
    );
    await expect(
      asOwner<{ count: number }>(
        `select count(*)::integer count
           from app.workspace_invitation_binding_replacement_claims
          where prior_intent_id=$1`,
        [midCycleIntentId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      asOwner(
        `select * from app.scan_workspace_invitation_replacement_claims(
          'workspace_purge',$1,$2,2)`,
        [purgeJobId, scanWorkspaceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ cycle_completed: true, deleted_count: 1, scanned_count: 1 }],
    });
    const firstCycleState = await readClaimScanState(purgeJobId);
    expectValidClaimScanBounds(firstCycleState);
    expect(firstCycleState).toMatchObject({ cycle_completed: true });
    expect(firstCycleState?.cursor_updated_at).toEqual(
      firstCycleState?.high_water_updated_at,
    );

    const remaining = await asOwner<{ count: number }>(
      `select count(*)::integer count
         from app.workspace_invitation_binding_replacement_claims
        where prior_intent_id=any($1::uuid[])`,
      [[initialIntentId, ...nextCycleIntentIds, midCycleIntentId]],
    );
    expect(remaining.rows).toEqual([{ count: 0 }]);
  });

  it('starts the first purge cycle after an empty completed scan', async () => {
    const { purgeJobId, scanWorkspaceId } = await createClaimScanPurgeJob();
    await expect(
      asOwner(
        `select * from app.scan_workspace_invitation_replacement_claims(
          'workspace_purge',$1,$2,2)`,
        [purgeJobId, scanWorkspaceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ cycle_completed: true, deleted_count: 0, scanned_count: 0 }],
    });
    const emptyState = await readClaimScanState(purgeJobId);
    expect(emptyState).toEqual({
      cursor_updated_at: null,
      cycle_completed: true,
      high_water_updated_at: null,
    });

    const firstIntentId = await insertReapableClaim(scanWorkspaceId);
    await expect(
      asOwner(
        `select * from app.scan_workspace_invitation_replacement_claims(
          'workspace_purge',$1,$2,2)`,
        [purgeJobId, scanWorkspaceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ cycle_completed: true, deleted_count: 1, scanned_count: 1 }],
    });
    const firstNonemptyState = await readClaimScanState(purgeJobId);
    expectValidClaimScanBounds(firstNonemptyState);
    expect(firstNonemptyState).toMatchObject({ cycle_completed: true });
    expect(firstNonemptyState?.cursor_updated_at).toEqual(
      firstNonemptyState?.high_water_updated_at,
    );
    await expect(
      asOwner<{ count: number }>(
        `select count(*)::integer count
           from app.workspace_invitation_binding_replacement_claims
          where prior_intent_id=$1`,
        [firstIntentId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('reaps only bounded terminal replay records and permits defined key reuse', async () => {
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

    const first = await retention.reapTransientData();
    expect(first.idempotencyRecordsDeleted).toBe(2);
    const second = await retention.reapTransientData();
    expect(second.idempotencyRecordsDeleted).toBe(1);

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

  it('preserves active sessions and lock-safe concurrent logout metadata', async () => {
    const activeId = randomUUID();
    const expiredId = randomUUID();
    const concurrentLogoutId = randomUUID();
    const activeAuthId = randomUUID();
    const expiredAuthId = randomUUID();
    await asOwner(
      `insert into app.sessions
        (id,user_id,token_digest,created_at,expires_at)
       values
        ($1,$4,$5,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day'),
        ($2,$4,$6,clock_timestamp()-interval '40 days',clock_timestamp()-interval '31 days'),
        ($3,$4,$7,clock_timestamp()-interval '40 days',clock_timestamp()-interval '31 days')`,
      [
        activeId,
        expiredId,
        concurrentLogoutId,
        userId,
        digest(activeId),
        digest(expiredId),
        digest(concurrentLogoutId),
      ],
    );
    await asOwner(
      `insert into app.auth_sessions
        (id,user_id,token,created_at,updated_at,expires_at)
       values
        ($1,$3,$4,clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day'),
        ($2,$3,$5,clock_timestamp()-interval '40 days',clock_timestamp()-interval '40 days',clock_timestamp()-interval '31 days')`,
      [
        activeAuthId,
        expiredAuthId,
        userId,
        `token-${activeAuthId}`,
        `token-${expiredAuthId}`,
      ],
    );

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        `update app.sessions set revoked_at=clock_timestamp()
         where id=$1`,
        [concurrentLogoutId],
      );
      const duringLogout = await retention.reapTransientData();
      expect(duringLogout.sessionsDeleted).toBe(2);
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }

    const retained = await asOwner<{ id: string; revoked: boolean }>(
      `select id,revoked_at is not null revoked
       from app.sessions where id=any($1::uuid[]) order by id`,
      [[activeId, concurrentLogoutId]],
    );
    expect(retained.rows).toHaveLength(2);
    expect(retained.rows.find((row) => row.id === concurrentLogoutId)).toEqual(
      expect.objectContaining({ revoked: true }),
    );
    const retainedAuth = await asOwner<{ id: string }>(
      `select id from app.auth_sessions where id=any($1::uuid[]) order by id`,
      [[activeAuthId, expiredAuthId]],
    );
    expect(retainedAuth.rows).toEqual([{ id: activeAuthId }]);
  });

  it('minimizes terminal invitation recipient data after 90 days', async () => {
    const invitationId = randomUUID();
    const receiptId = randomUUID();
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
    await asOwner(
      `insert into app.workspace_invitation_command_receipts
        (id,workspace_id,actor_user_id,operation,key_hash,request_hash,status,result_ref,
         created_at,updated_at)
       values($1,$2,$3,'create',$4,$5,'completed',
         jsonb_build_object('invitation',jsonb_build_object(
           'id',$6::uuid,'email','retained-recipient@example.test')),
         clock_timestamp()-interval '100 days',clock_timestamp()-interval '100 days')`,
      [
        receiptId,
        workspaceId,
        userId,
        digest(`key:${invitationId}`),
        digest(`request:${invitationId}`),
        invitationId,
      ],
    );

    const result = await retention.reapTransientData();
    expect(result.invitationPiiMinimized).toBe(1);
    const minimized = await asOwner<{
      recipient_email: string;
      receipt_email: string;
    }>(
      `select invitation.recipient_email,
              receipt.result_ref->'invitation'->>'email' receipt_email
         from app.workspace_invitations invitation
         join app.workspace_invitation_command_receipts receipt
           on receipt.id=$3
        where invitation.workspace_id=$1 and invitation.id=$2`,
      [workspaceId, invitationId, receiptId],
    );
    expect(minimized.rows[0]).toEqual({
      recipient_email: `minimized+${invitationId}@invalid.pertexo`,
      receipt_email: `minimized+${invitationId}@invalid.pertexo`,
    });
  });

  it('expires unattended invitations and reaps bounded abandoned intents safely', async () => {
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

    const result = await retention.reapTransientData();
    expect(result.invitationsExpired).toBe(1);
    expect(result.invitationAcceptanceIntentsDeleted).toBe(2);
    expect(result.invitationReplacementClaimsDeleted).toBe(1);
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

  it('retains a pruned intermediate claim while its descendant is live and reaps the terminal lineage', async () => {
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

    const retained = await retention.reapTransientData();
    expect(retained.invitationReplacementClaimsDeleted).toBe(0);
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
    const reaped = await retention.reapTransientData();
    expect(reaped.invitationReplacementClaimsDeleted).toBe(2);
    await expect(
      asOwner<{ count: number }>(
        `select count(*)::integer count
           from app.workspace_invitation_binding_replacement_claims
          where prior_intent_id in ($1,$2)`,
        [intentA, intentB],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('advances bounded claim cleanup past a held page and revisits it after release', async () => {
    const heldWorkspaceId = randomUUID();
    const holdId = randomUUID();
    const heldIntentIds = [randomUUID(), randomUUID()];
    const eligibleIntentIds = [randomUUID(), randomUUID(), randomUUID()];
    const arrivingIntentId = randomUUID();
    await asOwner(
      `insert into app.workspaces(id,name,slug,created_by)
       values($1,'Held claim cleanup',$2,$3)`,
      [heldWorkspaceId, `held-claim-${heldWorkspaceId}`, userId],
    );
    await asOwner(
      `select app.project_workspace_legal_hold(
        $1,1,$2,'legal_hold_placed',$3,$4,$5,'operator:test',
        'retention-test','held cleanup page',clock_timestamp())`,
      [heldWorkspaceId, randomUUID(), holdId, '0'.repeat(64), '7'.repeat(64)],
    );

    for (const [index, intentId] of heldIntentIds.entries()) {
      await asOwner(
        `insert into app.workspace_invitation_binding_replacement_claims
          (prior_workspace_id,prior_intent_id,prior_binding_digest,
           successor_workspace_id,successor_intent_id,successor_invitation_id,
           successor_invitation_revision,successor_binding_digest,
           successor_csrf_digest,created_at,updated_at)
         values($1,$2,$3,$1,$4,$5,1,$6,$7,
           timestamptz '2026-01-01 00:00:00+00'+$8*interval '1 second',
           timestamptz '2026-01-01 00:00:00+00'+$8*interval '1 second')`,
        [
          heldWorkspaceId,
          intentId,
          digest(`held-prior:${intentId}`),
          randomUUID(),
          randomUUID(),
          digest(`held-successor:${intentId}`),
          digest(`held-csrf:${intentId}`),
          index,
        ],
      );
    }
    for (const [index, intentId] of eligibleIntentIds.entries()) {
      await asOwner(
        `insert into app.workspace_invitation_binding_replacement_claims
          (prior_workspace_id,prior_intent_id,prior_binding_digest,
           successor_workspace_id,successor_intent_id,successor_invitation_id,
           successor_invitation_revision,successor_binding_digest,
           successor_csrf_digest,created_at,updated_at)
         values($1,$2,$3,$1,$4,$5,1,$6,$7,
           timestamptz '2026-01-02 00:00:00+00'+$8*interval '1 second',
           timestamptz '2026-01-02 00:00:00+00'+$8*interval '1 second')`,
        [
          workspaceId,
          intentId,
          digest(`eligible-prior:${intentId}`),
          randomUUID(),
          randomUUID(),
          digest(`eligible-successor:${intentId}`),
          digest(`eligible-csrf:${intentId}`),
          index,
        ],
      );
    }

    expect(
      (await retention.reapTransientData()).invitationReplacementClaimsDeleted,
    ).toBe(0);
    await asOwner(
      `insert into app.workspace_invitation_binding_replacement_claims
        (prior_workspace_id,prior_intent_id,prior_binding_digest,
         successor_workspace_id,successor_intent_id,successor_invitation_id,
         successor_invitation_revision,successor_binding_digest,
         successor_csrf_digest,created_at,updated_at)
       values($1,$2,$3,$1,$4,$5,1,$6,$7,
         timestamptz '2026-01-03 00:00:00+00',
         timestamptz '2026-01-03 00:00:00+00')`,
      [
        workspaceId,
        arrivingIntentId,
        digest(`arriving-prior:${arrivingIntentId}`),
        randomUUID(),
        randomUUID(),
        digest(`arriving-successor:${arrivingIntentId}`),
        digest(`arriving-csrf:${arrivingIntentId}`),
      ],
    );

    for (let pass = 0; pass < 4; pass += 1) await retention.reapTransientData();
    const progressed = await asOwner<{ count: number }>(
      `select count(*)::integer count
         from app.workspace_invitation_binding_replacement_claims
        where prior_intent_id=any($1::uuid[])`,
      [[...eligibleIntentIds, arrivingIntentId]],
    );
    expect(progressed.rows[0]?.count).toBe(0);
    await expect(
      asOwner<{ count: number }>(
        `select count(*)::integer count
           from app.workspace_invitation_binding_replacement_claims
          where prior_intent_id=any($1::uuid[])`,
        [heldIntentIds],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });

    const progress = await asOwner<{
      cursor_updated_at: Date | null;
      high_water_updated_at: Date | null;
    }>(
      `select cursor_updated_at,high_water_updated_at
         from app.workspace_invitation_claim_cleanup_cursors
        where scan_kind='transient'`,
    );
    expect(progress.rows).toHaveLength(1);
    expect(progress.rows[0]?.cursor_updated_at).not.toBeNull();
    expect(progress.rows[0]?.high_water_updated_at).not.toBeNull();
    expect(progress.rows[0]?.cursor_updated_at?.getTime()).toBeLessThanOrEqual(
      progress.rows[0]?.high_water_updated_at?.getTime() ?? 0,
    );

    await asOwner(
      `select app.project_workspace_legal_hold(
        $1,2,$2,'legal_hold_released',$3,$4,$5,'operator:test',
        'retention-test','test complete',clock_timestamp())`,
      [heldWorkspaceId, randomUUID(), holdId, '7'.repeat(64), '8'.repeat(64)],
    );
    for (let pass = 0; pass < 2; pass += 1) await retention.reapTransientData();
    await expect(
      asOwner<{ count: number }>(
        `select count(*)::integer count
           from app.workspace_invitation_binding_replacement_claims
          where prior_intent_id=any($1::uuid[])`,
        [heldIntentIds],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
