import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  noticeMailBatches,
  systemMailDeliveries,
} from '@pertexo/database/schema';
import {
  nextNoticeDue,
  nextPersonNoticeDue,
  noticeWindow,
  rolesForCapability,
} from '@pertexo/workflow-model';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { lockWorkspaceAuthority } from '../../shared/authority.queries.js';
import { createNoticeMailBatch } from './batches.repository.js';
import type { NoticeMailPerson, NoticeMailSealer } from './contract.js';
import { mailCutoff } from './items.js';
import { recipient, setNextDue, settings } from './recipients.repository.js';
import { readMailSubjects } from './subjects.queries.js';

/** One person's turn: release, wait, reschedule, or write their next mail. */
export async function preparePerson(
  client: PoolClient,
  person: NoticeMailPerson,
  seal: NoticeMailSealer,
): Promise<number> {
  await lockWorkspaceAuthority(
    client,
    person.workspace_id,
    person.user_id,
    rolesForCapability('workspace:read'),
  );
  const to = await recipient(client, person.workspace_id, person.user_id);
  if (!to?.email_verified) return 0;
  const current = await settings(client, person.workspace_id, person.user_id, {
    create: true,
  });
  const pref = current.pref;
  if (pref === undefined || current.effective.mode === 'off') return 0;
  const db = drizzle(client);
  const batchScope = and(
    eq(noticeMailBatches.workspaceId, person.workspace_id),
    eq(noticeMailBatches.userId, person.user_id),
    isNull(noticeMailBatches.releasedAt),
  );
  await db
    .update(noticeMailBatches)
    .set({ releasedAt: sql`clock_timestamp()` })
    .from(systemMailDeliveries)
    .where(
      and(
        eq(noticeMailBatches.id, systemMailDeliveries.id),
        batchScope,
        eq(systemMailDeliveries.status, 'failed'),
        eq(systemMailDeliveries.failureCode, 'notice.superseded'),
      ),
    )
    .catch(rethrowQueryFailure);
  const pending = await db
    .select({ id: noticeMailBatches.id })
    .from(noticeMailBatches)
    .innerJoin(
      systemMailDeliveries,
      eq(systemMailDeliveries.id, noticeMailBatches.id),
    )
    .where(
      and(
        batchScope,
        inArray(systemMailDeliveries.status, [
          'queued',
          'retry',
          'outcome_unknown',
        ]),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  if (pending.length !== 0) return 0;
  const setDue = (nextDueAt: Date | null) =>
    setNextDue(client, person, nextDueAt, current.defaultRevision);
  const advance = () => setDue(nextNoticeDue(current.effective, to.now));
  const due = nextPersonNoticeDue(pref, current);
  if (due === null) return 0;
  if (due > to.now) {
    await setDue(due);
    return 0;
  }
  const window = noticeWindow(current.effective, to.now);
  const reserved = await db
    .select({ id: noticeMailBatches.id })
    .from(noticeMailBatches)
    .where(and(batchScope, eq(noticeMailBatches.windowKey, window)))
    .catch(rethrowQueryFailure);
  if (reserved.length !== 0) {
    await advance();
    return 0;
  }
  const subjects = await readMailSubjects(client, person.workspace_id, {
    actorId: person.user_id,
    cut: mailCutoff(current.cut, to.created_at),
  });
  if (subjects.length === 0 && current.effective.mode === 'immediate') {
    await setDue(to.now);
    return 0;
  }
  await advance();
  if (subjects.length === 0) return 0;
  return createNoticeMailBatch(client, {
    person,
    to,
    current,
    pref,
    subjects,
    window,
    seal,
  });
}
