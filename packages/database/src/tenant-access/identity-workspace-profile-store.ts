import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { generatePersistedId } from '../platform/persisted-id.js';
import type {
  IdentityWorkspaceDatabase,
  UpdateUserProfileInput,
  UserProfileUpdateResult,
  UserRecord,
} from './identity-workspace-contracts.js';
import { UserProfileCommandConflictError } from './identity-workspace-errors.js';
import {
  commandKeyHash,
  commandKeySchema,
  commandRequestHash,
  commandRevisionSchema,
} from './identity-workspace-member-command.js';
import { mapUser } from './identity-workspace-rows.js';
import { parseIdentityUuid } from './identity-workspace-support.js';
import { withPlatformTransaction } from './workspace.js';

type ProfileStore = Pick<IdentityWorkspaceDatabase, 'updateUserProfile'>;

const USER_COLUMNS =
  'id,email,display_name,status,profile_revision,created_at,updated_at';
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}]+$/u);
/** The receipt keeps the applied name, not a copy of the whole profile. */
const durableResult = z
  .object({
    displayName: displayNameSchema,
    profileRevision: commandRevisionSchema,
    updatedAt: z.iso.datetime(),
    changed: z.boolean(),
  })
  .strict();

async function claimProfileReceipt(
  client: PoolClient,
  input: Readonly<{
    actorUserId: string;
    keyHash: string;
    requestHash: string;
  }>,
): Promise<Readonly<{ claimId: string }> | z.output<typeof durableResult>> {
  const claimId = generatePersistedId();
  const inserted = await client.query(
    `insert into app.user_profile_command_receipts
       (id,actor_user_id,key_hash,request_hash,status)
     values($1,$2,$3,$4,'in_progress')
     on conflict(actor_user_id,key_hash) do nothing`,
    [claimId, input.actorUserId, input.keyHash, input.requestHash],
  );
  if (inserted.rowCount === 1) return { claimId };
  const existing = await client.query<{
    request_hash: string;
    status: string;
    result_ref: unknown;
  }>(
    `select request_hash,status,result_ref from app.user_profile_command_receipts
     where actor_user_id=$1 and key_hash=$2 for update`,
    [input.actorUserId, input.keyHash],
  );
  const row = existing.rows[0];
  if (row?.request_hash !== input.requestHash)
    throw new UserProfileCommandConflictError(
      'idempotency_conflict',
      'The idempotency key belongs to another profile change',
    );
  const parsed = durableResult.safeParse(row.result_ref);
  if (row.status !== 'completed' || !parsed.success)
    throw new Error('User profile command receipt is incomplete');
  return parsed.data;
}

/**
 * ADR 043 self-service display-name change: a conditional, idempotent
 * command on the actor's own platform user row. It never reads or changes
 * email, status, credentials or sessions.
 */
export function createIdentityWorkspaceProfileStore(pool: Pool): ProfileStore {
  return Object.freeze({
    updateUserProfile: async (
      raw: UpdateUserProfileInput,
    ): Promise<UserProfileUpdateResult> => {
      const actorUserId = parseIdentityUuid(raw.actorUserId);
      const displayName = displayNameSchema.parse(raw.displayName);
      const expectedRevision = commandRevisionSchema.parse(
        raw.expectedRevision,
      );
      const keyHash = commandKeyHash(
        commandKeySchema.parse(raw.idempotencyKey),
      );
      const requestHash = commandRequestHash({
        actorUserId,
        displayName,
        expectedRevision,
      });
      return withPlatformTransaction(pool, async (client) => {
        const locked = await client.query(
          `select ${USER_COLUMNS} from app.users where id=$1 for update`,
          [actorUserId],
        );
        const row = locked.rows[0] as Record<string, unknown> | undefined;
        const current = row === undefined ? undefined : mapUser(row);
        if (current?.status !== 'active')
          throw new UserProfileCommandConflictError(
            'user_inactive',
            'Only an active user can change their profile',
          );
        const receipt = await claimProfileReceipt(client, {
          actorUserId,
          keyHash,
          requestHash,
        });
        if (!('claimId' in receipt))
          return Object.freeze({
            user: Object.freeze({
              ...current,
              displayName: receipt.displayName,
              profileRevision: receipt.profileRevision,
              updatedAt: new Date(receipt.updatedAt),
            }),
            changed: receipt.changed,
            replayed: true,
          });
        if (current.profileRevision !== expectedRevision)
          throw new UserProfileCommandConflictError(
            'revision_conflict',
            'The profile changed since it was loaded',
          );
        const changed = current.displayName !== displayName;
        let user: UserRecord = current;
        if (changed) {
          const updated = await client.query(
            `update app.users
             set display_name=$2,profile_revision=profile_revision+1,
                 updated_at=clock_timestamp()
             where id=$1 returning ${USER_COLUMNS}`,
            [actorUserId, displayName],
          );
          user = mapUser(updated.rows[0] as Record<string, unknown>);
          await client.query(
            'select app.record_identity_profile_audit_fact($1)',
            [actorUserId],
          );
        }
        const completed = await client.query(
          `update app.user_profile_command_receipts
           set status='completed',result_ref=$2::jsonb,updated_at=clock_timestamp()
           where id=$1 and status='in_progress'`,
          [
            receipt.claimId,
            JSON.stringify(
              durableResult.parse({
                displayName: user.displayName,
                profileRevision: user.profileRevision,
                updatedAt: user.updatedAt.toISOString(),
                changed,
              }),
            ),
          ],
        );
        if (completed.rowCount !== 1)
          throw new Error(
            'User profile command receipt could not be completed',
          );
        return Object.freeze({ user, changed, replayed: false });
      });
    },
  });
}
