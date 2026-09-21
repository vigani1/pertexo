import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { generatePersistedId } from '../platform/persisted-id.js';
import type {
  CompleteInvitationAcceptanceInput,
  IdentityWorkspaceDatabase,
  InvitationAcceptanceIntentRecord,
  InvitationAcceptanceResult,
  MembershipRole,
  ResolveInvitationAcceptanceInput,
} from './identity-workspace-contracts.js';
import { InvitationAcceptanceConflictError } from './identity-workspace-errors.js';
import { parseIdentityUuid } from './identity-workspace-support.js';
import { withTenantScopedClient } from './workspace.js';

type AcceptanceStore = Pick<
  IdentityWorkspaceDatabase,
  | 'resolveInvitationAcceptance'
  | 'readInvitationAcceptance'
  | 'recordInvitationAcceptanceProof'
  | 'completeInvitationAcceptance'
  | 'abandonInvitationAcceptance'
>;

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);
const role = z.enum(['owner', 'admin', 'builder', 'operator', 'viewer']);
const delegatedRole = z.enum(['admin', 'builder', 'operator', 'viewer']);
const receiptSchema = z
  .object({
    intentId: z.uuid(),
    workspaceId: z.uuid(),
    role,
    membershipCreated: z.boolean(),
  })
  .strict();

type IntentRow = Readonly<{
  id: string;
  workspace_id: string;
  invitation_id: string;
  invitation_revision: number;
  status: string;
  expires_at: Date;
  verified_user_id: string | null;
  verified_email: string | null;
  verified_at: Date | null;
  accepted_user_id: string | null;
  receipt: unknown;
  workspace_name: string | null;
  invitation_role: string | null;
  invitation_status: string | null;
}>;

type ReplacementClaimRow = Readonly<{
  successor_workspace_id: string;
  successor_intent_id: string;
  successor_invitation_id: string;
  successor_invitation_revision: number;
  successor_binding_digest: string;
  successor_csrf_digest: string;
}>;

type ReplacementIntentRow = Readonly<{
  id: string;
  invitation_id: string;
  invitation_revision: number;
  binding_digest: string;
  csrf_digest: string;
  status: string;
  expires_at: Date;
}>;

const intentSelection = `intent.id,intent.workspace_id,intent.invitation_id,
  intent.invitation_revision,intent.status,intent.expires_at,
  intent.verified_user_id,intent.verified_email,intent.verified_at,
  intent.accepted_user_id,intent.receipt,workspace.name workspace_name,
  invitation.role invitation_role,invitation.status invitation_status`;

function mapIntent(row: IntentRow): InvitationAcceptanceIntentRecord {
  const parsedReceipt =
    row.receipt === null ? null : receiptSchema.parse(row.receipt);
  return Object.freeze({
    id: z.uuid().parse(row.id),
    workspaceId: z.uuid().parse(row.workspace_id),
    invitationId: z.uuid().parse(row.invitation_id),
    invitationRevision: z
      .number()
      .int()
      .positive()
      .parse(row.invitation_revision),
    status: z
      .enum([
        'pending',
        'verified',
        'wrong_account',
        'completed',
        'abandoned',
        'superseded',
      ])
      .parse(row.status),
    expiresAt: z.coerce.date().parse(row.expires_at),
    verifiedUserId:
      row.verified_user_id === null
        ? null
        : z.uuid().parse(row.verified_user_id),
    verifiedEmail: row.verified_email,
    verifiedAt:
      row.verified_at === null ? null : z.coerce.date().parse(row.verified_at),
    workspaceName: row.workspace_name,
    invitationRole:
      row.invitation_role === null
        ? null
        : delegatedRole.parse(row.invitation_role),
    invitationStatus:
      row.invitation_status === null
        ? null
        : z
            .enum(['pending', 'accepted', 'revoked', 'expired'])
            .parse(row.invitation_status),
    acceptedUserId:
      row.accepted_user_id === null
        ? null
        : z.uuid().parse(row.accepted_user_id),
    receipt: parsedReceipt,
  });
}

async function selectIntent(
  client: PoolClient,
  clause: string,
  values: readonly unknown[],
  lock = false,
): Promise<InvitationAcceptanceIntentRecord | null> {
  const result = await client.query<IntentRow>(
    `select ${intentSelection}
       from app.workspace_invitation_acceptance_intents intent
       left join app.workspace_invitations invitation on invitation.id=intent.invitation_id
       left join app.workspaces workspace on workspace.id=intent.workspace_id
      where ${clause}${lock ? ' for update of intent' : ''}`,
    [...values],
  );
  return result.rows[0] === undefined ? null : mapIntent(result.rows[0]);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requestHash(input: Record<string, unknown>): string {
  return sha256(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(input).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    ),
  );
}

async function replacementLineageIsLive(
  client: PoolClient,
  initial: Readonly<{
    workspaceId: string;
    intentId: string;
    bindingDigest: string;
    intent: ReplacementIntentRow | undefined;
  }>,
  now: Date,
): Promise<boolean> {
  let current = initial;
  const visited = new Set<string>();
  for (let depth = 0; depth < 32; depth += 1) {
    const identity = `${current.workspaceId}:${current.intentId}`;
    if (visited.has(identity)) return true;
    visited.add(identity);
    if (
      current.intent !== undefined &&
      current.intent.status !== 'completed' &&
      current.intent.status !== 'abandoned' &&
      current.intent.status !== 'superseded' &&
      current.intent.expires_at.getTime() > now.getTime()
    )
      return true;
    const claimResult = await client.query<ReplacementClaimRow>(
      `select successor_workspace_id,successor_intent_id,
              successor_invitation_id,successor_invitation_revision,
              successor_binding_digest,successor_csrf_digest
         from app.workspace_invitation_binding_replacement_claims
        where prior_workspace_id=$1 and prior_intent_id=$2
          and prior_binding_digest=$3`,
      [current.workspaceId, current.intentId, current.bindingDigest],
    );
    const claim = claimResult.rows[0];
    if (claim === undefined) return false;
    await client.query("select set_config('app.workspace_id',$1,true)", [
      claim.successor_workspace_id,
    ]);
    const intentResult = await client.query<ReplacementIntentRow>(
      `select id,invitation_id,invitation_revision,binding_digest,
              csrf_digest,status,expires_at
         from app.workspace_invitation_acceptance_intents
        where workspace_id=$1 and id=$2
        for update`,
      [claim.successor_workspace_id, claim.successor_intent_id],
    );
    current = {
      workspaceId: claim.successor_workspace_id,
      intentId: claim.successor_intent_id,
      bindingDigest: claim.successor_binding_digest,
      intent: intentResult.rows[0],
    };
  }
  return true;
}

export function createIdentityWorkspaceInvitationAcceptanceStore(
  pool: Pool,
): AcceptanceStore {
  return Object.freeze({
    resolveInvitationAcceptance: async (
      raw: ResolveInvitationAcceptanceInput,
    ) => {
      const workspaceId = parseIdentityUuid(raw.workspaceId);
      const invitationId = parseIdentityUuid(raw.invitationId);
      const intentId = parseIdentityUuid(raw.intentId);
      const tokenDigest = digest.parse(raw.tokenDigest);
      const bindingDigest = digest.parse(raw.bindingDigest);
      const csrfDigest = digest.parse(raw.csrfDigest);
      const priorBinding =
        raw.priorBinding === undefined
          ? undefined
          : {
              workspaceId: parseIdentityUuid(raw.priorBinding.workspaceId),
              intentId: parseIdentityUuid(raw.priorBinding.intentId),
              bindingDigest: digest.parse(raw.priorBinding.bindingDigest),
            };
      return withTenantScopedClient(pool, { workspaceId }, async (client) => {
        const invitation = await client.query<{
          revision: number;
          expires_at: Date;
          status: string;
        }>(
          `select revision,expires_at,status from app.workspace_invitations
            where workspace_id=$1 and id=$2 and token_digest=$3 for update`,
          [workspaceId, invitationId, tokenDigest],
        );
        const current = invitation.rows[0];
        if (current?.status !== 'pending') return null;
        const now = new Date();
        if (current.expires_at.getTime() <= now.getTime()) {
          await client.query(
            `update app.workspace_invitations
                set status='expired',delivery_status='canceled',updated_at=clock_timestamp()
              where workspace_id=$1 and id=$2`,
            [workspaceId, invitationId],
          );
          await client.query(
            `update app.workspace_invitation_delivery_attempts
                set status=case when status in ('queued','failed') then 'canceled' else status end,
                    token_ciphertext=null,token_nonce=null,token_tag=null,
                    token_key_version=null,updated_at=clock_timestamp()
              where workspace_id=$1 and invitation_id=$2
                and status in ('queued','failed','unknown')`,
            [workspaceId, invitationId],
          );
          return null;
        }
        const expiresAt = new Date(
          Math.min(raw.expiresAt.getTime(), current.expires_at.getTime()),
        );
        if (priorBinding !== undefined) {
          await client.query(
            'select pg_advisory_xact_lock(hashtextextended($1,0))',
            [priorBinding.bindingDigest],
          );
        }
        const insertIntent = () =>
          client.query<{ id: string }>(
            `insert into app.workspace_invitation_acceptance_intents
             (id,workspace_id,invitation_id,invitation_revision,binding_digest,
              csrf_digest,status,expires_at)
           values($1,$2,$3,$4,$5,$6,'pending',$7)
           on conflict(id) do nothing
           returning id`,
            [
              intentId,
              workspaceId,
              invitationId,
              current.revision,
              bindingDigest,
              csrfDigest,
              expiresAt,
            ],
          );
        let inserted;
        if (priorBinding !== undefined) {
          await client.query("select set_config('app.workspace_id',$1,true)", [
            priorBinding.workspaceId,
          ]);
          const claimInsert = await client.query(
            `insert into app.workspace_invitation_binding_replacement_claims
             (prior_workspace_id,prior_intent_id,prior_binding_digest,
              successor_workspace_id,successor_intent_id,successor_invitation_id,
              successor_invitation_revision,successor_binding_digest,successor_csrf_digest)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9)
             on conflict(prior_workspace_id,prior_intent_id,prior_binding_digest)
             do nothing`,
            [
              priorBinding.workspaceId,
              priorBinding.intentId,
              priorBinding.bindingDigest,
              workspaceId,
              intentId,
              invitationId,
              current.revision,
              bindingDigest,
              csrfDigest,
            ],
          );
          if (claimInsert.rowCount === 1) {
            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [workspaceId],
            );
            inserted = await insertIntent();
          } else {
            const claimed = await client.query<ReplacementClaimRow>(
              `select successor_workspace_id,successor_intent_id,
                    successor_invitation_id,successor_invitation_revision,
                    successor_binding_digest,successor_csrf_digest
               from app.workspace_invitation_binding_replacement_claims
              where prior_workspace_id=$1 and prior_intent_id=$2
                and prior_binding_digest=$3
              for update`,
              [
                priorBinding.workspaceId,
                priorBinding.intentId,
                priorBinding.bindingDigest,
              ],
            );
            const claim = claimed.rows[0];
            if (claim === undefined) return null;
            const exactClaim =
              claim.successor_workspace_id === workspaceId &&
              claim.successor_intent_id === intentId &&
              claim.successor_invitation_id === invitationId &&
              claim.successor_invitation_revision === current.revision &&
              claim.successor_binding_digest === bindingDigest &&
              claim.successor_csrf_digest === csrfDigest;

            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [claim.successor_workspace_id],
            );
            const claimedIntent = await client.query<ReplacementIntentRow>(
              `select id,invitation_id,invitation_revision,binding_digest,
                    csrf_digest,status,expires_at
               from app.workspace_invitation_acceptance_intents
              where workspace_id=$1 and id=$2
              for update`,
              [claim.successor_workspace_id, claim.successor_intent_id],
            );
            const successor = claimedIntent.rows[0];
            if (exactClaim) {
              if (
                successor === undefined ||
                successor.status === 'abandoned' ||
                successor.status === 'superseded' ||
                successor.expires_at.getTime() <= now.getTime()
              )
                return null;
              return selectIntent(client, 'intent.id=$1', [intentId]);
            }
            if (
              await replacementLineageIsLive(
                client,
                {
                  workspaceId: claim.successor_workspace_id,
                  intentId: claim.successor_intent_id,
                  bindingDigest: claim.successor_binding_digest,
                  intent: successor,
                },
                now,
              )
            )
              return null;

            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [workspaceId],
            );
            const staleCandidate = await client.query<{ id: string }>(
              `select id from app.workspace_invitation_acceptance_intents
              where workspace_id=$1 and id=$2`,
              [workspaceId, intentId],
            );
            if (staleCandidate.rowCount !== 0) return null;

            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [priorBinding.workspaceId],
            );
            await client.query(
              `update app.workspace_invitation_binding_replacement_claims
                set successor_workspace_id=$4,successor_intent_id=$5,
                    successor_invitation_id=$6,successor_invitation_revision=$7,
                    successor_binding_digest=$8,successor_csrf_digest=$9,
                    updated_at=clock_timestamp()
              where prior_workspace_id=$1 and prior_intent_id=$2
                and prior_binding_digest=$3`,
              [
                priorBinding.workspaceId,
                priorBinding.intentId,
                priorBinding.bindingDigest,
                workspaceId,
                intentId,
                invitationId,
                current.revision,
                bindingDigest,
                csrfDigest,
              ],
            );
            await client.query(
              "select set_config('app.workspace_id',$1,true)",
              [workspaceId],
            );
            inserted = await insertIntent();
          }
        } else {
          inserted = await insertIntent();
        }
        if (inserted.rowCount !== 1) return null;
        if (priorBinding !== undefined) {
          await client.query("select set_config('app.workspace_id',$1,true)", [
            priorBinding.workspaceId,
          ]);
          await client.query(
            `update app.workspace_invitation_acceptance_intents
                set status='abandoned',abandoned_at=clock_timestamp(),updated_at=clock_timestamp()
              where workspace_id=$1 and id=$2 and binding_digest=$3
                and status in ('pending','verified','wrong_account')`,
            [
              priorBinding.workspaceId,
              priorBinding.intentId,
              priorBinding.bindingDigest,
            ],
          );
          await client.query("select set_config('app.workspace_id',$1,true)", [
            workspaceId,
          ]);
        }
        return selectIntent(client, 'intent.id=$1', [intentId]);
      });
    },

    readInvitationAcceptance: async (workspaceIdInput, bindingDigestInput) => {
      const workspaceId = parseIdentityUuid(workspaceIdInput);
      const bindingDigest = digest.parse(bindingDigestInput);
      return withTenantScopedClient(pool, { workspaceId }, (client) =>
        selectIntent(
          client,
          'intent.workspace_id=$1 and intent.binding_digest=$2',
          [workspaceId, bindingDigest],
        ),
      );
    },

    recordInvitationAcceptanceProof: async (raw) => {
      const workspaceId = parseIdentityUuid(raw.workspaceId);
      const intentId = parseIdentityUuid(raw.intentId);
      const userId = parseIdentityUuid(raw.userId);
      const bindingDigest = digest.parse(raw.bindingDigest);
      const normalizedEmail = z
        .email()
        .parse(raw.verifiedEmail.trim())
        .normalize('NFKC')
        .toLowerCase();
      return withTenantScopedClient(pool, { workspaceId }, async (client) => {
        const locked = await client.query<{
          accepted_user_id: string | null;
          recipient_email: string;
          expires_at: Date;
          status: string;
        }>(
          `select invitation.recipient_email,intent.expires_at,intent.status,
                  intent.accepted_user_id
             from app.workspace_invitation_acceptance_intents intent
             join app.workspace_invitations invitation on invitation.id=intent.invitation_id
            where intent.workspace_id=$1 and intent.id=$2 and intent.binding_digest=$3
            for update of intent`,
          [workspaceId, intentId, bindingDigest],
        );
        const current = locked.rows[0];
        if (
          current === undefined ||
          current.expires_at.getTime() <= raw.verifiedAt.getTime()
        )
          return null;
        if (current.status === 'completed')
          return current.accepted_user_id === userId
            ? selectIntent(client, 'intent.id=$1', [intentId])
            : null;
        if (!['pending', 'verified', 'wrong_account'].includes(current.status))
          return null;
        const matches =
          current.recipient_email.normalize('NFKC').toLowerCase() ===
          normalizedEmail;
        await client.query(
          `update app.workspace_invitation_acceptance_intents
              set status=$4,verified_user_id=$5,verified_email=$6,verified_at=$7,
                  updated_at=clock_timestamp()
            where workspace_id=$1 and id=$2 and binding_digest=$3`,
          [
            workspaceId,
            intentId,
            bindingDigest,
            matches ? 'verified' : 'wrong_account',
            userId,
            normalizedEmail,
            raw.verifiedAt,
          ],
        );
        return selectIntent(client, 'intent.id=$1', [intentId]);
      });
    },

    completeInvitationAcceptance: async (
      raw: CompleteInvitationAcceptanceInput,
    ) => completeAcceptance(pool, raw),

    abandonInvitationAcceptance: async (
      workspaceIdInput,
      intentIdInput,
      bindingDigestInput,
    ) => {
      const workspaceId = parseIdentityUuid(workspaceIdInput);
      const intentId = parseIdentityUuid(intentIdInput);
      const bindingDigest = digest.parse(bindingDigestInput);
      return withTenantScopedClient(pool, { workspaceId }, async (client) => {
        const updated = await client.query(
          `update app.workspace_invitation_acceptance_intents
              set status='abandoned',abandoned_at=clock_timestamp(),updated_at=clock_timestamp()
            where workspace_id=$1 and id=$2 and binding_digest=$3
              and status in ('pending','verified','wrong_account')`,
          [workspaceId, intentId, bindingDigest],
        );
        return updated.rowCount === 1;
      });
    },
  });
}

async function completeAcceptance(
  pool: Pool,
  raw: CompleteInvitationAcceptanceInput,
): Promise<InvitationAcceptanceResult> {
  const workspaceId = parseIdentityUuid(raw.workspaceId);
  const intentId = parseIdentityUuid(raw.intentId);
  const actorUserId = parseIdentityUuid(raw.actorUserId);
  const invitationRevision = z
    .number()
    .int()
    .positive()
    .parse(raw.invitationRevision);
  const keyHash = sha256(key.parse(raw.idempotencyKey));
  const commandHash = requestHash({
    actorUserId,
    intentId,
    invitationRevision,
    workspaceId,
  });
  return withTenantScopedClient(
    pool,
    { workspaceId, actorId: actorUserId },
    async (client) => {
      const preview = await selectIntent(client, 'intent.id=$1', [intentId]);
      if (preview === null)
        throw new InvitationAcceptanceConflictError(
          'unavailable',
          'The invitation journey is unavailable',
        );
      const workspace = await client.query<{ status: string }>(
        'select status from app.workspaces where id=$1 for update',
        [workspaceId],
      );
      const user = await client.query<{ status: string }>(
        'select status from app.users where id=$1 for update',
        [actorUserId],
      );
      const membership = await client.query<{
        role: MembershipRole;
        status: string;
      }>(
        `select role,status from app.workspace_memberships
          where workspace_id=$1 and user_id=$2 for update`,
        [workspaceId, actorUserId],
      );
      const invitation = await client.query<{
        status: string;
        revision: number;
        role: string;
        normalized_email: string;
        expires_at: Date;
      }>(
        `select status,revision,role,normalized_email,expires_at
           from app.workspace_invitations where workspace_id=$1 and id=$2 for update`,
        [workspaceId, preview.invitationId],
      );
      const intent = await selectIntent(
        client,
        'intent.id=$1',
        [intentId],
        true,
      );
      if (intent === null)
        throw new InvitationAcceptanceConflictError(
          'unavailable',
          'The invitation journey is unavailable',
        );
      const priorReceipt = await client.query<{
        request_hash: string;
        status: string;
        result_ref: unknown;
      }>(
        `select request_hash,status,result_ref
           from app.workspace_invitation_command_receipts
          where actor_user_id=$1 and workspace_id=$2 and operation='accept' and key_hash=$3
          for update`,
        [actorUserId, workspaceId, keyHash],
      );
      const priorReceiptRow = priorReceipt.rows[0];
      if (
        priorReceiptRow !== undefined &&
        priorReceiptRow.request_hash !== commandHash
      )
        throw new InvitationAcceptanceConflictError(
          'idempotency_conflict',
          'The key belongs to another acceptance command',
        );
      if (priorReceiptRow !== undefined) {
        const prior = receiptSchema.safeParse(priorReceiptRow.result_ref);
        if (priorReceiptRow.status !== 'completed' || !prior.success)
          throw new Error('Invitation acceptance receipt is incomplete');
        return Object.freeze({
          ...prior.data,
          replayed: true,
          replacementSessionCreated: false,
        });
      }
      if (intent.status === 'completed') {
        if (intent.acceptedUserId !== actorUserId || intent.receipt === null)
          throw new InvitationAcceptanceConflictError(
            'unavailable',
            'The invitation receipt is unavailable',
          );
        return Object.freeze({
          ...intent.receipt,
          replayed: true,
          replacementSessionCreated: false,
        });
      }
      if (user.rows[0]?.status !== 'active')
        throw new InvitationAcceptanceConflictError(
          'member_inactive',
          'The accepting user is not active',
        );
      const receiptId = generatePersistedId();
      const claimed = await client.query(
        `insert into app.workspace_invitation_command_receipts
           (id,workspace_id,actor_user_id,operation,key_hash,request_hash,status)
         values($1,$2,$3,'accept',$4,$5,'in_progress')
         on conflict(actor_user_id,workspace_id,operation,key_hash) do nothing`,
        [receiptId, workspaceId, actorUserId, keyHash, commandHash],
      );
      if (claimed.rowCount !== 1) {
        const existing = await client.query<{
          request_hash: string;
          status: string;
          result_ref: unknown;
        }>(
          `select request_hash,status,result_ref from app.workspace_invitation_command_receipts
            where actor_user_id=$1 and workspace_id=$2 and operation='accept' and key_hash=$3 for update`,
          [actorUserId, workspaceId, keyHash],
        );
        const row = existing.rows[0];
        if (row?.request_hash !== commandHash)
          throw new InvitationAcceptanceConflictError(
            'idempotency_conflict',
            'The key belongs to another acceptance command',
          );
        const prior = receiptSchema.safeParse(row.result_ref);
        if (row.status !== 'completed' || !prior.success)
          throw new Error('Invitation acceptance receipt is incomplete');
        return Object.freeze({
          ...prior.data,
          replayed: true,
          replacementSessionCreated: false,
        });
      }
      const now = new Date();
      if (intent.expiresAt.getTime() <= now.getTime())
        throw new InvitationAcceptanceConflictError(
          'expired',
          'The invitation journey expired',
        );
      if (intent.status === 'superseded')
        throw new InvitationAcceptanceConflictError(
          'superseded',
          'The invitation journey was superseded',
        );
      if (
        intent.status !== 'verified' ||
        intent.verifiedUserId !== actorUserId ||
        intent.verifiedAt === null ||
        now.getTime() - intent.verifiedAt.getTime() > 5 * 60_000
      )
        throw new InvitationAcceptanceConflictError(
          'proof_expired',
          'Fresh recipient verification is required',
        );
      if (intent.invitationRevision !== invitationRevision)
        throw new InvitationAcceptanceConflictError(
          'revision_conflict',
          'The invitation changed',
        );
      if (workspace.rows[0]?.status !== 'active')
        throw new InvitationAcceptanceConflictError(
          'workspace_inactive',
          'The workspace is not active',
        );
      const current = invitation.rows[0];
      if (
        current?.status !== 'pending' ||
        current.expires_at.getTime() <= now.getTime() ||
        current.revision !== invitationRevision
      )
        throw new InvitationAcceptanceConflictError(
          'superseded',
          'The invitation is no longer pending',
        );
      if (current.normalized_email !== intent.verifiedEmail)
        throw new InvitationAcceptanceConflictError(
          'recipient_mismatch',
          'The verified recipient does not match',
        );
      const existing = membership.rows[0];
      if (existing !== undefined && existing.status !== 'active')
        throw new InvitationAcceptanceConflictError(
          'member_inactive',
          'Inactive membership cannot be restored by invitation',
        );
      const membershipCreated = existing === undefined;
      const assignedRole = existing?.role ?? delegatedRole.parse(current.role);
      if (membershipCreated) {
        await client.query(
          `insert into app.workspace_memberships(workspace_id,user_id,role,status)
           values($1,$2,$3,'active')`,
          [workspaceId, actorUserId, assignedRole],
        );
        await client.query(
          `update app.sessions set revoked_at=coalesce(revoked_at,clock_timestamp())
            where user_id=$1 and revoked_at is null`,
          [actorUserId],
        );
        await client.query(
          `insert into app.sessions(id,user_id,token_digest,expires_at,user_agent,ip_address)
           values($1,$2,$3,$4,$5,$6)`,
          [
            raw.replacementSession.id,
            actorUserId,
            digest.parse(raw.replacementSession.tokenDigest),
            raw.replacementSession.expiresAt,
            raw.replacementSession.userAgent ?? null,
            raw.replacementSession.ipAddress ?? null,
          ],
        );
      }
      const receipt = receiptSchema.parse({
        intentId,
        workspaceId,
        role: assignedRole,
        membershipCreated,
      });
      await client.query(
        `update app.workspace_invitations
            set status='accepted',accepted_by=$3,accepted_at=clock_timestamp(),
                delivery_status='canceled',updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [workspaceId, intent.invitationId, actorUserId],
      );
      await client.query(
        `update app.workspace_invitation_delivery_attempts
            set token_ciphertext=null,token_nonce=null,token_tag=null,token_key_version=null,
                status=case when status='queued' then 'canceled' else status end,
                updated_at=clock_timestamp()
          where workspace_id=$1 and invitation_id=$2`,
        [workspaceId, intent.invitationId],
      );
      await client.query(
        `update app.workspace_invitation_acceptance_intents
            set status='completed',accepted_user_id=$3,receipt=$4::jsonb,
                completed_at=clock_timestamp(),updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [workspaceId, intentId, actorUserId, JSON.stringify(receipt)],
      );
      await client.query(
        `insert into app.audit_events
           (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
         values($1,$2,$3,'workspace.invitation_accepted','workspace_invitation',$4,$5,$6,$7::jsonb)`,
        [
          generatePersistedId(),
          workspaceId,
          actorUserId,
          intent.invitationId,
          raw.requestId ?? null,
          raw.traceId ?? null,
          JSON.stringify({
            invitationRevision,
            membershipCreated,
            role: assignedRole,
          }),
        ],
      );
      await client.query(
        `update app.workspace_invitation_command_receipts
            set status='completed',result_ref=$2::jsonb,updated_at=clock_timestamp()
          where id=$1 and status='in_progress'`,
        [receiptId, JSON.stringify(receipt)],
      );
      return Object.freeze({
        ...receipt,
        replayed: false,
        replacementSessionCreated: membershipCreated,
      });
    },
  );
}
