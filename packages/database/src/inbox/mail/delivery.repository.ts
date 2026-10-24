import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { alias } from 'drizzle-orm/pg-core';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  noticePreferences,
  noticeWorkspaceSettings,
} from '../../schema/inbox/preferences.js';
import { noticeMailBatches, noticeMailItems } from '../../schema/inbox/mail.js';
import { systemMailDeliveries } from '../../schema/mail/deliveries.js';
import {
  users as usersTable,
  workspaceMemberships as membershipsTable,
  workspaces,
} from '../../schema/foundation.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import type { PoolClient } from 'pg';
import type { NoticeSchedule } from '@pertexo/contracts';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { insertSystemMail } from '../../platform/mail/store.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../tenant-access/workspaces/authority.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import {
  projectNoticePreferences,
  type PreferenceRow,
} from '../preferences/settings.queries.js';
import { noticeWindow, nextNoticeDue } from './schedule.js';
import { readMailSubjects, mailItem } from './subjects.queries.js';
import type { NoticeMailStore, NoticeMailSealer } from './contract.js';
const users = alias(usersTable, 'person');
const workspaceMemberships = alias(membershipsTable, 'member');
type Person = Readonly<{ workspace_id: string; user_id: string }>;
async function recipient(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
) {
  const [found] = await drizzle(client)
    .select({
      email: users.email,
      workspace_name: workspaces.name,
      email_verified: users.emailVerified,
      role_revision: workspaceMemberships.roleRevision,
      created_at: workspaceMemberships.createdAt,
      now: sql<Date>`clock_timestamp()`.mapWith(workspaceMemberships.createdAt),
    })
    .from(users)
    .innerJoin(workspaceMemberships, eq(workspaceMemberships.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, actorId),
        eq(workspaceMemberships.status, 'active'),
        eq(users.status, 'active'),
      ),
    )
    .for('share', { of: [users, workspaceMemberships] })
    .catch(rethrowQueryFailure);
  return found;
}
async function settings(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  { create }: Readonly<{ create: boolean }>,
) {
  const db = drizzle(client);
  const [defaults] = await db
    .select()
    .from(noticeWorkspaceSettings)
    .where(eq(noticeWorkspaceSettings.workspaceId, workspaceId))
    .for('share')
    .catch(rethrowQueryFailure);
  if (create)
    await db
      .insert(noticePreferences)
      .values({ workspaceId, userId: actorId })
      .onConflictDoNothing()
      .catch(rethrowQueryFailure);
  const [pref] = await db
    .select()
    .from(noticePreferences)
    .where(
      and(
        eq(noticePreferences.workspaceId, workspaceId),
        eq(noticePreferences.userId, actorId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const projected = projectNoticePreferences(pref, defaults, {
    canManageDefaults: false,
    emailAvailable: true,
  });
  const cut = new Date(
    Math.max(
      pref?.revision === 0 ? 0 : (pref?.changedAt.getTime() ?? 0),
      pref?.mode === null ? (defaults?.changedAt.getTime() ?? 0) : 0,
    ),
  );
  return {
    pref,
    defaults,
    effective: projected.effective,
    cut,
    defaultRevision: pref?.mode === null ? projected.defaults.revision : 0,
  };
}
async function advance(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    schedule,
    now,
    defaultRevision,
  }: Readonly<{
    actorId: string;
    schedule: NoticeSchedule;
    now: Date;
    defaultRevision: number;
  }>,
) {
  await drizzle(client)
    .update(noticePreferences)
    .set({
      nextDueAt: nextNoticeDue(schedule, now),
      scheduleDefaultRevision: defaultRevision,
    })
    .where(
      and(
        eq(noticePreferences.workspaceId, workspaceId),
        eq(noticePreferences.userId, actorId),
      ),
    )
    .catch(rethrowQueryFailure);
}
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

function nextPersonNoticeDue(
  pref: PreferenceRow,
  current: Awaited<ReturnType<typeof settings>>,
): Date | null {
  if (
    pref.nextDueAt !== null &&
    pref.scheduleDefaultRevision === current.defaultRevision
  ) {
    return pref.nextDueAt;
  }
  if (current.effective.mode === 'immediate') {
    return current.cut;
  }
  return nextNoticeDue(current.effective, current.cut);
}
