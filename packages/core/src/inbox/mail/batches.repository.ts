import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { drizzle } from 'drizzle-orm/node-postgres';
import { noticeMailBatches, noticeMailItems } from '@pertexo/database/schema';
import type { PoolClient } from 'pg';
import {
  insertSystemMail,
  generatePersistedId,
} from '@pertexo/database/platform';
import type { PreferenceRow } from '../preferences/effective.js';
import type { NoticeMailPerson, NoticeMailSealer } from './contract.js';
import { mailItem } from './items.js';
import type { recipient, settings } from './recipients.repository.js';
import type { MailSubjectRow } from './subjects.queries.js';

/** A mail not sent within a day is stale news; the next one says what's current. */
const MAIL_LIFETIME_MILLIS = 24 * 3_600_000;

export async function createNoticeMailBatch(
  client: PoolClient,
  {
    person,
    to,
    current,
    pref,
    subjects,
    window,
    seal,
  }: Readonly<{
    person: NoticeMailPerson;
    to: NonNullable<Awaited<ReturnType<typeof recipient>>>;
    current: Pick<Awaited<ReturnType<typeof settings>>, 'defaultRevision'>;
    pref: Pick<PreferenceRow, 'revision'>;
    subjects: readonly MailSubjectRow[];
    window: string;
    seal: NoticeMailSealer;
  }>,
): Promise<number> {
  const db = drizzle(client);
  const id = generatePersistedId();
  const expiresAt = new Date(to.now.getTime() + MAIL_LIFETIME_MILLIS);
  const sealedPayload = seal({
    id,
    expiresAt,
    toEmail: to.email,
    workspaceName: to.workspace_name,
    workspaceId: person.workspace_id,
    actorId: person.user_id,
    revision: pref.revision,
    memberRevision: to.role_revision,
    items: subjects.map(mailItem),
  });
  await insertSystemMail(client, {
    id,
    purpose: 'workspace_notice',
    expiresAt,
    sealedPayload,
  });
  await db
    .insert(noticeMailBatches)
    .values({
      id,
      workspaceId: person.workspace_id,
      userId: person.user_id,
      preferenceRevision: pref.revision,
      defaultRevision: current.defaultRevision,
      memberRevision: to.role_revision,
      recipient: to.email,
      windowKey: window,
      itemCount: subjects.length,
    })
    .catch(rethrowQueryFailure);
  await db
    .insert(noticeMailItems)
    .values(
      subjects.map((row) => ({
        workspaceId: person.workspace_id,
        batchId: id,
        threadId: row.id,
        revision: BigInt(row.revision),
      })),
    )
    .catch(rethrowQueryFailure);
  return 1;
}
