import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { noticeMailBatches, noticeMailItems } from '../../schema/inbox/mail.js';
import type { PoolClient } from 'pg';
import {insertSystemMail} from '../../platform/mail/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { PreferenceRow } from '../preferences/settings.queries.js';
import { mailItem } from './subjects.queries.js';
import type { NoticeMailSealer } from './contract.js';
import type { recipient, settings, Person } from './recipients.repository.js';
import type { MailSubjectRow } from './subjects.queries.js';
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
    person: Person;
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
  const expiresAt = new Date(to.now.getTime() + 24 * 3_600_000);
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
