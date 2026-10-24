import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  noticePreferences,
  noticeWorkspaceSettings,
  noticeSubscriptions,
} from '../../schema/inbox/preferences.js';
import type { NoticeCommandResponse } from '@pertexo/contracts';
import type { PoolClient } from 'pg';

import { claimCommand, completeCommand } from '../../platform/idempotency/repository.js';
import {
  NoticeConflictError,
  type NoticePreferencesStore,
} from './contract.js';
export async function replacePreference(
  client: PoolClient,
  command:
    | Readonly<{
        input: Parameters<NoticePreferencesStore['replace']>[0];
        defaults: false;
      }>
    | Readonly<{
        input: Parameters<NoticePreferencesStore['replaceDefaults']>[0];
        defaults: true;
      }>,
) {
  const { input, defaults } = command;
  const identity = {
    workspaceId: input.workspaceId,
    scope: input.actorId,
    operation: defaults
      ? 'notice.defaults.replace'
      : 'notice.preferences.replace',
    idempotencyKey: input.idempotencyKey,
  };
  const request = {
    mode: input.mode,
    hour: input.hour,
    timeZone: input.timeZone,
    expectedRevision: input.expectedRevision,
  };
  const replay = await claimCommand<Omit<NoticeCommandResponse, 'replayed'>>(
    client,
    {
      ...identity,
      resourceId: input.workspaceId,
      request,
    },
  );
  if (replay !== null)
    return {
      ...replay,
      replayed: true,
    };
  const db = drizzle(client);
  if (defaults)
    await db
      .insert(noticeWorkspaceSettings)
      .values({ workspaceId: input.workspaceId })
      .onConflictDoNothing()
      .catch(rethrowQueryFailure);
  else
    await db
      .insert(noticePreferences)
      .values({ workspaceId: input.workspaceId, userId: input.actorId })
      .onConflictDoNothing()
      .catch(rethrowQueryFailure);
  const table = defaults ? noticeWorkspaceSettings : noticePreferences;
  const predicate = and(
    eq(table.workspaceId, input.workspaceId),
    defaults ? undefined : eq(noticePreferences.userId, input.actorId),
  );
  const [row] = await db
    .select({
      revision: table.revision,
      mode: table.mode,
      hour: table.hour,
      timeZone: table.timeZone,
    })
    .from(table)
    .where(predicate)
    .for('update')
    .catch(rethrowQueryFailure);
  if (row?.revision !== input.expectedRevision) throw new NoticeConflictError();
  const changed =
    row.mode !== input.mode ||
    row.hour !== input.hour ||
    row.timeZone !== input.timeZone;
  const revision = row.revision + (changed ? 1 : 0);
  if (changed) {
    const values = {
      revision,
      mode: input.mode,
      hour: input.hour,
      timeZone: input.timeZone,
      changedAt: sql`clock_timestamp()`,
    };
    if (defaults)
      await db
        .update(noticeWorkspaceSettings)
        .set({ ...values, mode: input.mode })
        .where(predicate)
        .catch(rethrowQueryFailure);
    else
      await db
        .update(noticePreferences)
        .set({ ...values, nextDueAt: null })
        .where(predicate)
        .catch(rethrowQueryFailure);
  }
  const result = { revision, changed };
  await completeCommand(client, identity, result);
  return { ...result, replayed: false };
}
export async function replaceSubscription(
  client: PoolClient,
  input: Parameters<NoticePreferencesStore['replaceSubscription']>[0],
) {
  const identity = {
    workspaceId: input.workspaceId,
    scope: input.actorId,
    operation: 'notice.subscription.replace',
    idempotencyKey: input.idempotencyKey,
  };
  const request = {
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    expectedRevision: input.expectedRevision,
    followed: input.followed,
    muted: input.muted,
  };
  const replay = await claimCommand<Omit<NoticeCommandResponse, 'replayed'>>(
    client,
    {
      ...identity,
      resourceId: input.subjectId,
      request,
    },
  );
  if (replay !== null)
    return {
      ...replay,
      replayed: true,
    };
  const db = drizzle(client);
  await db
    .insert(noticeSubscriptions)
    .values({
      workspaceId: input.workspaceId,
      userId: input.actorId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      workflowId: input.subjectKind === 'workflow' ? input.subjectId : null,
      connectionId: input.subjectKind === 'connection' ? input.subjectId : null,
    })
    .onConflictDoNothing()
    .catch(rethrowQueryFailure);
  const predicate = and(
    eq(noticeSubscriptions.workspaceId, input.workspaceId),
    eq(noticeSubscriptions.userId, input.actorId),
    eq(noticeSubscriptions.subjectKind, input.subjectKind),
    eq(noticeSubscriptions.subjectId, input.subjectId),
  );
  const [row] = await db
    .select()
    .from(noticeSubscriptions)
    .where(predicate)
    .for('update')
    .catch(rethrowQueryFailure);
  if (row?.revision !== input.expectedRevision) throw new NoticeConflictError();
  const changed = row.followed !== input.followed || row.muted !== input.muted;
  if (changed)
    await db
      .update(noticeSubscriptions)
      .set({
        revision: row.revision + 1,
        followed: input.followed,
        muted: input.muted,
        changedAt: sql`clock_timestamp()`,
      })
      .where(predicate)
      .catch(rethrowQueryFailure);
  const result = { revision: row.revision + (changed ? 1 : 0), changed };
  await completeCommand(client, identity, result);
  return { ...result, replayed: false };
}
