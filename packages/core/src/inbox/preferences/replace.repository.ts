import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  noticePreferences,
  noticeWorkspaceSettings,
  noticeSubscriptions,
} from '@pertexo/database/schema';
import type { PoolClient } from 'pg';

import type {
  ReplaceNoticeDefaultsInput,
  ReplaceNoticePreferencesInput,
  ReplaceNoticeSubscriptionInput,
} from './notice-preferences.types.js';

/** A person's own preference row, or the workspace's defaults row. */
export type PreferenceTarget = Readonly<{
  workspaceId: string;
  actorId: string;
  defaults: boolean;
}>;

/** A person's preference change, or the workspace defaults' change. */
export type PreferenceCommand =
  | Readonly<{ input: ReplaceNoticePreferencesInput; defaults: false }>
  | Readonly<{ input: ReplaceNoticeDefaultsInput; defaults: true }>;

/** Creates the row if it's missing, then locks it. */
export async function lockPreference(
  client: PoolClient,
  target: PreferenceTarget,
) {
  const db = drizzle(client);
  if (target.defaults)
    await db
      .insert(noticeWorkspaceSettings)
      .values({ workspaceId: target.workspaceId })
      .onConflictDoNothing()
      .catch(rethrowQueryFailure);
  else
    await db
      .insert(noticePreferences)
      .values({ workspaceId: target.workspaceId, userId: target.actorId })
      .onConflictDoNothing()
      .catch(rethrowQueryFailure);
  const table = target.defaults ? noticeWorkspaceSettings : noticePreferences;
  const [row] = await db
    .select({
      revision: table.revision,
      mode: table.mode,
      hour: table.hour,
      timeZone: table.timeZone,
    })
    .from(table)
    .where(preferencePredicate(target))
    .for('update')
    .catch(rethrowQueryFailure);
  return row;
}

export async function updatePreference(
  client: PoolClient,
  command: PreferenceCommand,
  revision: number,
): Promise<void> {
  const db = drizzle(client);
  const { input } = command;
  const target = { ...input, defaults: command.defaults };
  const values = {
    revision,
    mode: input.mode,
    hour: input.hour,
    timeZone: input.timeZone,
    changedAt: sql`clock_timestamp()`,
  };
  if (command.defaults)
    await db
      .update(noticeWorkspaceSettings)
      .set({ ...values, mode: command.input.mode })
      .where(preferencePredicate(target))
      .catch(rethrowQueryFailure);
  else
    await db
      .update(noticePreferences)
      .set({ ...values, nextDueAt: null })
      .where(preferencePredicate(target))
      .catch(rethrowQueryFailure);
}

function preferencePredicate(target: PreferenceTarget) {
  const table = target.defaults ? noticeWorkspaceSettings : noticePreferences;
  return and(
    eq(table.workspaceId, target.workspaceId),
    target.defaults ? undefined : eq(noticePreferences.userId, target.actorId),
  );
}

type SubscriptionKey = Pick<
  ReplaceNoticeSubscriptionInput,
  'workspaceId' | 'actorId' | 'subjectKind' | 'subjectId'
>;

/** Creates the row if it's missing, then locks it. */
export async function lockSubscription(
  client: PoolClient,
  input: SubscriptionKey,
): Promise<typeof noticeSubscriptions.$inferSelect | undefined> {
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
  const [row] = await db
    .select()
    .from(noticeSubscriptions)
    .where(subscriptionPredicate(input))
    .for('update')
    .catch(rethrowQueryFailure);
  return row;
}

export async function updateSubscription(
  client: PoolClient,
  input: SubscriptionKey,
  values: Readonly<{ revision: number; followed: boolean; muted: boolean }>,
): Promise<void> {
  await drizzle(client)
    .update(noticeSubscriptions)
    .set({
      revision: values.revision,
      followed: values.followed,
      muted: values.muted,
      changedAt: sql`clock_timestamp()`,
    })
    .where(subscriptionPredicate(input))
    .catch(rethrowQueryFailure);
}

function subscriptionPredicate(input: SubscriptionKey) {
  return and(
    eq(noticeSubscriptions.workspaceId, input.workspaceId),
    eq(noticeSubscriptions.userId, input.actorId),
    eq(noticeSubscriptions.subjectKind, input.subjectKind),
    eq(noticeSubscriptions.subjectId, input.subjectId),
  );
}
