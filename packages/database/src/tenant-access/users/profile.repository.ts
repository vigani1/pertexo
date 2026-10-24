import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { users } from '../../schema/foundation.js';
import { userProfileCommandReceipts } from '../../schema/authentication.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { recordIdentitySecurityFact } from '../../identity/facts.repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  commandKeySchema,
  commandRevisionSchema,
  hashFlatIdentityCommand,
  hashIdentityCommandKey,
} from '../command-keys.js';
import type {
  IdentityWorkspaceDatabase,
  UpdateUserProfileInput,
  UserProfileUpdateResult,
  UserRecord,
} from '../contract.js';
import { UserProfileCommandConflictError } from '../errors.js';
import { userRecord, userSelection } from './projection.js';
import { parseIdentityUuid } from '../support.js';
import { withPlatformTransaction } from '../transactions.js';

type ProfileStore = Pick<IdentityWorkspaceDatabase, 'updateUserProfile'>;

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
  const db = drizzle(client);
  const inserted = await db
    .insert(userProfileCommandReceipts)
    .values({
      id: claimId,
      actorUserId: input.actorUserId,
      keyHash: input.keyHash,
      requestHash: input.requestHash,
      status: 'in_progress',
    })
    .onConflictDoNothing({
      target: [
        userProfileCommandReceipts.actorUserId,
        userProfileCommandReceipts.keyHash,
      ],
    })
    .returning({ id: userProfileCommandReceipts.id })
    .catch(rethrowQueryFailure);
  if (inserted.length === 1) return { claimId };
  const existing = await db
    .select({
      requestHash: userProfileCommandReceipts.requestHash,
      status: userProfileCommandReceipts.status,
      resultRef: userProfileCommandReceipts.resultRef,
    })
    .from(userProfileCommandReceipts)
    .where(
      and(
        eq(userProfileCommandReceipts.actorUserId, input.actorUserId),
        eq(userProfileCommandReceipts.keyHash, input.keyHash),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const row = existing[0];
  if (row?.requestHash !== input.requestHash)
    throw new UserProfileCommandConflictError(
      'idempotency_conflict',
      'The idempotency key belongs to another profile change',
    );
  const parsed = durableResult.safeParse(row.resultRef);
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
      const keyHash = hashIdentityCommandKey(
        commandKeySchema.parse(raw.idempotencyKey),
      );
      const requestHash = hashFlatIdentityCommand({
        actorUserId,
        displayName,
        expectedRevision,
      });
      return withPlatformTransaction(pool, async (client) => {
        const db = drizzle(client);
        const locked = await db
          .select(userSelection)
          .from(users)
          .where(eq(users.id, actorUserId))
          .for('update')
          .catch(rethrowQueryFailure);
        const row = locked[0];
        const current = row === undefined ? undefined : userRecord(row);
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
          const updated = await db
            .update(users)
            .set({
              displayName,
              profileRevision: sql`${users.profileRevision}+1`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(users.id, actorUserId))
            .returning(userSelection)
            .catch(rethrowQueryFailure);
          const changedUser = updated[0];
          if (changedUser === undefined)
            throw new Error('Profile update returned no record');
          user = userRecord(changedUser);
          await recordIdentitySecurityFact(
            client,
            actorUserId,
            'profile.display_name_changed',
          );
        }
        const completed = await db
          .update(userProfileCommandReceipts)
          .set({
            status: 'completed',
            resultRef: sql`${JSON.stringify(durableResult.parse({ displayName: user.displayName, profileRevision: user.profileRevision, updatedAt: user.updatedAt.toISOString(), changed }))}::jsonb`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(userProfileCommandReceipts.id, receipt.claimId),
              eq(userProfileCommandReceipts.status, 'in_progress'),
            ),
          )
          .returning({ id: userProfileCommandReceipts.id })
          .catch(rethrowQueryFailure);
        if (completed.length !== 1)
          throw new Error(
            'User profile command receipt could not be completed',
          );
        return Object.freeze({ user, changed, replayed: false });
      });
    },
  });
}
