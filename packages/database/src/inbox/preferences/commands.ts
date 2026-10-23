import type { NoticeCommandResponse } from '@pertexo/contracts';
import type { PoolClient } from 'pg';

import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import {
  NoticeConflictError,
  type NoticePreferencesStore,
} from './contract.js';
export async function replacePreference(
  client: PoolClient,
  input:
    | Parameters<NoticePreferencesStore['replace']>[0]
    | Parameters<NoticePreferencesStore['replaceDefaults']>[0],
  defaults: boolean,
) {
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
  if (defaults)
    await client.query(
      'insert into app.notice_workspace_settings(workspace_id) values($1) on conflict do nothing',
      [input.workspaceId],
    );
  else
    await client.query(
      'insert into app.notice_preferences(workspace_id,user_id) values($1,$2) on conflict do nothing',
      [input.workspaceId, input.actorId],
    );
  const table = defaults ? 'notice_workspace_settings' : 'notice_preferences';
  const parameters = defaults
    ? [input.workspaceId]
    : [input.workspaceId, input.actorId];
  const found = await client.query<{
    revision: number;
    mode: string | null;
    hour: number;
    time_zone: string;
  }>(
    `select revision,mode,hour,time_zone from app.${table} where workspace_id=$1 ${defaults ? '' : 'and user_id=$2'} for update`,
    parameters,
  );
  const row = found.rows[0];
  if (row?.revision !== input.expectedRevision) throw new NoticeConflictError();
  const changed =
    row.mode !== input.mode ||
    row.hour !== input.hour ||
    row.time_zone !== input.timeZone;
  const revision = row.revision + (changed ? 1 : 0);
  if (changed) {
    const offset = parameters.length;
    await client.query(
      `update app.${table} set revision=revision+1,mode=$${String(offset + 1)},hour=$${String(offset + 2)},time_zone=$${String(offset + 3)},changed_at=clock_timestamp() ${defaults ? '' : ',next_due_at=null'} where workspace_id=$1 ${defaults ? '' : 'and user_id=$2'}`,
      [...parameters, input.mode, input.hour, input.timeZone],
    );
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
  await client.query(
    `insert into app.notice_subscriptions(workspace_id,user_id,subject_kind,subject_id,workflow_id,connection_id) values($1,$2,$3,$4,$5,$6) on conflict do nothing`,
    [
      input.workspaceId,
      input.actorId,
      input.subjectKind,
      input.subjectId,
      input.subjectKind === 'workflow' ? input.subjectId : null,
      input.subjectKind === 'connection' ? input.subjectId : null,
    ],
  );
  const found = await client.query<{
    revision: number;
    followed: boolean;
    muted: boolean;
  }>(
    'select revision,followed,muted from app.notice_subscriptions where workspace_id=$1 and user_id=$2 and subject_kind=$3 and subject_id=$4 for update',
    [input.workspaceId, input.actorId, input.subjectKind, input.subjectId],
  );
  const row = found.rows[0];
  if (row?.revision !== input.expectedRevision) throw new NoticeConflictError();
  const changed = row.followed !== input.followed || row.muted !== input.muted;
  if (changed)
    await client.query(
      'update app.notice_subscriptions set revision=revision+1,followed=$5,muted=$6,changed_at=clock_timestamp() where workspace_id=$1 and user_id=$2 and subject_kind=$3 and subject_id=$4',
      [
        input.workspaceId,
        input.actorId,
        input.subjectKind,
        input.subjectId,
        input.followed,
        input.muted,
      ],
    );
  const result = { revision: row.revision + (changed ? 1 : 0), changed };
  await completeCommand(client, identity, result);
  return { ...result, replayed: false };
}
