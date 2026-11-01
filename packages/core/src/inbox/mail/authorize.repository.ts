import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { noticeMailBatches, noticeMailItems } from '@pertexo/database/schema';
import { rolesForCapability } from '@pertexo/workflow-model';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { lockWorkspaceAuthority } from '../../shared/authority.queries.js';
import type { NoticeMailPerson } from './contract.js';
import { mailCutoff } from './items.js';
import { recipient, settings } from './recipients.repository.js';
import { readMailSubjects } from './subjects.queries.js';

/** Sends only a mail whose person, schedule and subjects are all still what was prepared. */
export async function authorizeBatch(
  client: PoolClient,
  person: NoticeMailPerson,
  deliveryId: string,
): Promise<boolean> {
  const { workspace_id: workspaceId, user_id: actorId } = person;
  await lockWorkspaceAuthority(
    client,
    workspaceId,
    actorId,
    rolesForCapability('workspace:read'),
  );
  const db = drizzle(client);
  const [batch] = await db
    .select()
    .from(noticeMailBatches)
    .where(
      and(
        eq(noticeMailBatches.workspaceId, workspaceId),
        eq(noticeMailBatches.userId, actorId),
        eq(noticeMailBatches.id, deliveryId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (batch?.releasedAt !== null) return false;
  const to = await recipient(client, workspaceId, actorId);
  const recipientChanged =
    !to?.email_verified ||
    to.email !== batch.recipient ||
    to.role_revision !== batch.memberRevision;
  if (recipientChanged) return false;
  const current = await settings(client, workspaceId, actorId, {
    create: false,
  });
  const preferencesChanged =
    current.pref?.revision !== batch.preferenceRevision ||
    current.defaultRevision !== batch.defaultRevision ||
    current.effective.mode === 'off';
  if (preferencesChanged) return false;
  const items = await db
    .select({ thread_id: noticeMailItems.threadId })
    .from(noticeMailItems)
    .where(
      and(
        eq(noticeMailItems.workspaceId, workspaceId),
        eq(noticeMailItems.batchId, deliveryId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (items.length !== batch.itemCount) return false;
  const subjects = await readMailSubjects(client, workspaceId, {
    actorId,
    cut: mailCutoff(current.cut, to.created_at),
    onlyIds: items.map((row) => row.thread_id),
  });
  return subjects.length === batch.itemCount;
}
