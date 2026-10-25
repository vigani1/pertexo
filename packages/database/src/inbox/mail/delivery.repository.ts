import {
  nextPersonNoticeDue,
  noticeWindow,
  rolesForCapability,
} from '@pertexo/workflow-model';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  workspaceMemberships as membershipsTable,
  workspaces,
} from '../../schema/foundation.js';
import { noticeMailBatches, noticeMailItems } from '../../schema/inbox/mail.js';
import {
  noticePreferences,
  noticeWorkspaceSettings,
} from '../../schema/inbox/preferences.js';
import { systemMailDeliveries } from '../../schema/mail/deliveries.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../tenant-access/workspaces/authority.queries.js';
import { createNoticeMailBatch } from './batches.repository.js';
import type { NoticeMailSealer, NoticeMailStore } from './contract.js';
import {
  advance,
  recipient,
  settings,
  type Person,
} from './recipients.repository.js';
import { readMailSubjects } from './subjects.queries.js';
const workspaceMemberships = alias(membershipsTable, 'member');
async function preparePerson(
  client: PoolClient,
  person: Person,
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
  const due = nextPersonNoticeDue(pref, current);
  if (due === null) return 0;
  if (due > to.now) {
    await db
      .update(noticePreferences)
      .set({ nextDueAt: due, scheduleDefaultRevision: current.defaultRevision })
      .where(
        and(
          eq(noticePreferences.workspaceId, person.workspace_id),
          eq(noticePreferences.userId, person.user_id),
        ),
      )
      .catch(rethrowQueryFailure);
    return 0;
  }
  const window = noticeWindow(current.effective, to.now);
  const reserved = await db
    .select({ id: noticeMailBatches.id })
    .from(noticeMailBatches)
    .where(and(batchScope, eq(noticeMailBatches.windowKey, window)))
    .catch(rethrowQueryFailure);
  if (reserved.length !== 0) {
    await advance(client, person.workspace_id, {
      actorId: person.user_id,
      schedule: current.effective,
      now: to.now,
      defaultRevision: current.defaultRevision,
    });
    return 0;
  }
  const subjects = await readMailSubjects(client, person.workspace_id, {
    actorId: person.user_id,
    cut: new Date(Math.max(current.cut.getTime(), to.created_at.getTime())),
  });
  if (subjects.length === 0 && current.effective.mode === 'immediate') {
    await db
      .update(noticePreferences)
      .set({
        nextDueAt: to.now,
        scheduleDefaultRevision: current.defaultRevision,
      })
      .where(
        and(
          eq(noticePreferences.workspaceId, person.workspace_id),
          eq(noticePreferences.userId, person.user_id),
        ),
      )
      .catch(rethrowQueryFailure);
    return 0;
  }
  await advance(client, person.workspace_id, {
    actorId: person.user_id,
    schedule: current.effective,
    now: to.now,
    defaultRevision: current.defaultRevision,
  });
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
async function authorizeBatch(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  deliveryId: string,
): Promise<boolean> {
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
    cut: new Date(Math.max(current.cut.getTime(), to.created_at.getTime())),
    onlyIds: items.map((row) => row.thread_id),
  });
  return subjects.length === batch.itemCount;
}
export function createNoticeMailStore(
  config: DatabaseConfig,
  maintenanceConfig: DatabaseConfig,
  seal: NoticeMailSealer,
  runtime?: DatabaseRuntime,
): NoticeMailStore {
  const lease = acquireDatabasePool(config, runtime);
  const maintenance = acquireDatabasePool(maintenanceConfig);
  let after: Person | undefined;
  return {
    close: async () => {
      await lease.close();
      await maintenance.close();
    },
    prepare: async (signal) => {
      signal?.throwIfAborted();
      const db = drizzle(maintenance.pool);
      const candidates = await db
        .select({
          workspace_id: workspaceMemberships.workspaceId,
          user_id: workspaceMemberships.userId,
        })
        .from(workspaceMemberships)
        .innerJoin(
          workspaces,
          eq(workspaces.id, workspaceMemberships.workspaceId),
        )
        .leftJoin(
          noticePreferences,
          and(
            eq(noticePreferences.workspaceId, workspaceMemberships.workspaceId),
            eq(noticePreferences.userId, workspaceMemberships.userId),
          ),
        )
        .leftJoin(
          noticeWorkspaceSettings,
          eq(
            noticeWorkspaceSettings.workspaceId,
            workspaceMemberships.workspaceId,
          ),
        )
        .where(
          and(
            eq(workspaceMemberships.status, 'active'),
            eq(workspaces.status, 'active'),
            sql`coalesce(${noticePreferences.mode},${noticeWorkspaceSettings.mode},'off')<>'off'`,
            or(
              isNull(noticePreferences.nextDueAt),
              sql`${noticePreferences.nextDueAt}<=clock_timestamp()`,
              sql`${noticePreferences.mode} is null and ${noticePreferences.scheduleDefaultRevision}<>coalesce(${noticeWorkspaceSettings.revision},0)`,
            ),
            after === undefined
              ? undefined
              : sql`(${workspaceMemberships.workspaceId},${workspaceMemberships.userId})>(${after.workspace_id}::uuid,${after.user_id}::uuid)`,
          ),
        )
        .orderBy(workspaceMemberships.workspaceId, workspaceMemberships.userId)
        .limit(10)
        .catch(rethrowQueryFailure);
      let count = 0;
      for (const person of candidates) {
        signal?.throwIfAborted();
        try {
          count += await withTenantScopedClient(
            lease.pool,
            { workspaceId: person.workspace_id, actorId: person.user_id },
            (client) => preparePerson(client, person, seal),
            {
              statementTimeoutMillis: 5000,
              ...(signal === undefined ? {} : { signal }),
            },
          );
        } catch (error) {
          if (!(error instanceof WorkspaceAccessDeniedError)) throw error;
        }
        after = person;
      }
      if (candidates.length < 10) after = undefined;
      return count;
    },
    authorize: async (deliveryId) => {
      const [person] = await drizzle(maintenance.pool)
        .select({
          workspace_id: noticeMailBatches.workspaceId,
          user_id: noticeMailBatches.userId,
        })
        .from(noticeMailBatches)
        .where(eq(noticeMailBatches.id, deliveryId))
        .catch(rethrowQueryFailure);
      if (person === undefined) return false;
      try {
        return await withTenantScopedClient(
          lease.pool,
          { workspaceId: person.workspace_id, actorId: person.user_id },
          async (client) => {
            await lockWorkspaceAuthority(
              client,
              person.workspace_id,
              person.user_id,
              rolesForCapability('workspace:read'),
            );
            return authorizeBatch(
              client,
              person.workspace_id,
              person.user_id,
              deliveryId,
            );
          },
          { statementTimeoutMillis: 5000 },
        );
      } catch (error) {
        if (error instanceof WorkspaceAccessDeniedError) return false;
        throw error;
      }
    },
  };
}
