import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import type { NoticeCommandResponse } from '@pertexo/contracts';
import type { PoolClient } from 'pg';

import type { ReplaceNoticeSubscriptionInput } from './notice-preferences.types.js';
import { NoticeConflictError } from './notice-preferences.errors.js';
import {
  lockPreference,
  lockSubscription,
  updatePreference,
  updateSubscription,
  type PreferenceCommand,
} from './replace.repository.js';

export async function replacePreference(
  client: PoolClient,
  command: PreferenceCommand,
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
  const target = {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    defaults,
  };
  const row = await lockPreference(client, target);
  if (row?.revision !== input.expectedRevision) throw new NoticeConflictError();
  const changed =
    row.mode !== input.mode ||
    row.hour !== input.hour ||
    row.timeZone !== input.timeZone;
  const revision = row.revision + (changed ? 1 : 0);
  if (changed) await updatePreference(client, command, revision);
  const result = { revision, changed };
  await completeCommand(client, identity, result);
  return { ...result, replayed: false };
}

export async function replaceSubscription(
  client: PoolClient,
  input: ReplaceNoticeSubscriptionInput,
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
  const row = await lockSubscription(client, input);
  if (row?.revision !== input.expectedRevision) throw new NoticeConflictError();
  const changed = row.followed !== input.followed || row.muted !== input.muted;
  if (changed)
    await updateSubscription(client, input, {
      revision: row.revision + 1,
      followed: input.followed,
      muted: input.muted,
    });
  const result = { revision: row.revision + (changed ? 1 : 0), changed };
  await completeCommand(client, identity, result);
  return { ...result, replayed: false };
}
