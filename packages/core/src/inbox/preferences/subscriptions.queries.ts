import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  noticeSubscriptions,
  workflows,
} from '@pertexo/database/schema';
import type { NoticeSubscription } from '@pertexo/contracts';
import type { Role } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { readFolderScope } from '../../shared/facts.queries.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';
import {
  NoticeUnavailableError,
  type ReadNoticeSubscriptionInput,
} from './contract.js';

/** The workflow or connection exists and, for a workflow, this person can see it. */
export async function requireSubject(
  client: PoolClient,
  input: ReadNoticeSubscriptionInput,
  role: Role,
  { locking }: Readonly<{ locking: boolean }>,
): Promise<void> {
  const db = drizzle(client);
  const table = input.subjectKind === 'workflow' ? workflows : connections;
  const visible =
    input.subjectKind === 'workflow'
      ? workflowScopeSql(
          await readFolderScope(client, input, role),
          sql`${workflows.id}`,
        )
      : undefined;
  const query = db
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.workspaceId, input.workspaceId),
        eq(table.id, input.subjectId),
        visible,
      ),
    )
    .$dynamic();
  const found = await (locking ? query.for('share') : query).catch(
    rethrowQueryFailure,
  );
  if (found.length !== 1)
    throw new NoticeUnavailableError('This subject is unavailable.');
}

export async function readSubscription(
  client: PoolClient,
  input: ReadNoticeSubscriptionInput,
): Promise<NoticeSubscription> {
  const [found] = await drizzle(client)
    .select({
      revision: noticeSubscriptions.revision,
      followed: noticeSubscriptions.followed,
      muted: noticeSubscriptions.muted,
    })
    .from(noticeSubscriptions)
    .where(
      and(
        eq(noticeSubscriptions.workspaceId, input.workspaceId),
        eq(noticeSubscriptions.userId, input.actorId),
        eq(noticeSubscriptions.subjectKind, input.subjectKind),
        eq(noticeSubscriptions.subjectId, input.subjectId),
      ),
    )
    .catch(rethrowQueryFailure);
  return found ?? { revision: 0, followed: false, muted: false };
}
