import { and, asc, eq, inArray } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import { alias } from 'drizzle-orm/pg-core';

import { workspaceMemberships, users } from '@pertexo/database/schema';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import type { PoolClient } from 'pg';

/** The active members among `userIds`, share-locked in user order. */
export async function shareLockActiveMembers(
  client: PoolClient,
  workspaceId: string,
  userIds: readonly string[],
) {
  const member = alias(workspaceMemberships, 'member');
  const actor = alias(users, 'actor');
  const result = await drizzle(client)
    .select({ userId: member.userId })
    .from(member)
    .innerJoin(
      actor,
      and(eq(actor.id, member.userId), eq(actor.status, 'active')),
    )
    .where(
      and(
        eq(member.workspaceId, workspaceId),
        inArray(member.userId, [...userIds].sort()),
        eq(member.status, 'active'),
      ),
    )
    .orderBy(asc(member.userId))
    .for('share', { of: [member, actor] })
    .catch(rethrowQueryFailure);
  return result;
}
