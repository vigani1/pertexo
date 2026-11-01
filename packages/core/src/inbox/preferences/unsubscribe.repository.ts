import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  noticePreferences,
  workspaceMemberships,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { UnsubscribeNoticeMailInput } from './contract.js';

/** An unsubscribe link holds while the membership and preference it was sent for do. */
export async function unsubscribeMail(
  client: PoolClient,
  input: UnsubscribeNoticeMailInput,
): Promise<boolean> {
  const db = drizzle(client);
  const [member] = await db
    .select({ roleRevision: workspaceMemberships.roleRevision })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.actorId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (member?.roleRevision !== input.memberRevision) return false;
  const predicate = and(
    eq(noticePreferences.workspaceId, input.workspaceId),
    eq(noticePreferences.userId, input.actorId),
  );
  const [row] = await db
    .select({
      revision: noticePreferences.revision,
      mode: noticePreferences.mode,
    })
    .from(noticePreferences)
    .where(predicate)
    .for('update')
    .catch(rethrowQueryFailure);
  if (row === undefined) return false;
  if (row.mode === 'off' && row.revision === input.revision + 1) return true;
  if (row.revision !== input.revision) return false;
  await db
    .update(noticePreferences)
    .set({
      mode: 'off',
      revision: row.revision + 1,
      changedAt: sql`clock_timestamp()`,
      nextDueAt: null,
    })
    .where(predicate)
    .catch(rethrowQueryFailure);
  return true;
}
