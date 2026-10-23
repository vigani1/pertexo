import type { NoticeSubscription } from '@pertexo/contracts';
import { sql } from 'drizzle-orm';
import { readFolderScope } from '../../tenant-access/resources/facts.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../tenant-access/resources/query-scope.js';
import type { Pool, PoolClient } from 'pg';

import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../../tenant-access/transactions.js';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../../tenant-access/workspaces/authority.js';
import { hasCapability, rolesForCapability } from '@pertexo/workflow-model';
import {
  NoticeUnavailableError,
  type NoticePreferencesStore,
  type NoticeReader,
  type NoticeSubject,
} from './contract.js';
import { readNoticePreferences } from './read.js';
import { replacePreference, replaceSubscription } from './commands.js';
async function subjectExists(
  client: PoolClient,
  input: NoticeReader & NoticeSubject,
  { locking = false }: Readonly<{ locking?: boolean | undefined }> = {},
) {
  const table = input.subjectKind === 'workflow' ? 'workflows' : 'connections';
  const parameters: unknown[] = [input.workspaceId, input.subjectId];
  const visible =
    input.subjectKind === 'workflow'
      ? bindResourcePredicate(
          workflowScopeSql(
            await readFolderScope(client, input),
            sql`subject.id`,
          ),
          parameters,
        )
      : 'true';
  const found = await client.query(
    `select subject.id from app.${table} subject where subject.workspace_id=$1 and subject.id=$2 and ${visible} ${locking ? 'for share' : ''}`,
    parameters,
  );
  if (found.rowCount !== 1)
    throw new NoticeUnavailableError('This subject is unavailable.');
}
export function createNoticePreferencesStore(
  config: DatabaseConfig,
  {
    emailAvailable,
    runtime,
  }: Readonly<{
    emailAvailable: boolean;
    runtime?: DatabaseRuntime | undefined;
  }>,
): NoticePreferencesStore {
  const lease = acquireDatabasePool(config, runtime);

  const context = { pool: lease.pool, emailAvailable };
  return {
    close: () => lease.close(),
    read: (input) => readPersonalPreferences(context, input),
    replace: (input) => replacePersonalPreferences(context, input),
    replaceDefaults: (input) => replaceDefaultPreferences(context, input),
    readSubscription: (input) => readPersonalSubscription(context, input),
    replaceSubscription: (input) => replacePersonalSubscription(context, input),
    unsubscribe: (input) => unsubscribePersonalMail(context, input),
  };
}

function scope(input: NoticeReader) {
  return {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
  };
}
function options(input: NoticeReader) {
  return input.signal === undefined ? {} : { signal: input.signal };
}
function readPersonalPreferences(
  context: NoticePreferenceContext,
  input: Parameters<NoticePreferencesStore['read']>[0],
): ReturnType<NoticePreferencesStore['read']> {
  return withTenantScopedReadClient(
    context.pool,
    scope(input),
    async (client) => {
      const role = await readWorkspaceAuthority(client, input.workspaceId, {
        actorId: input.actorId,
        roles: rolesForCapability('workspace:read'),
      });
      return readNoticePreferences(client, input.workspaceId, {
        actorId: input.actorId,
        canManageDefaults: hasCapability(role, 'notification:manage_defaults'),
        emailAvailable: context.emailAvailable,
      });
    },
    options(input),
  );
}

function replacePersonalPreferences(
  context: NoticePreferenceContext,
  input: Parameters<NoticePreferencesStore['replace']>[0],
): ReturnType<NoticePreferencesStore['replace']> {
  return withTenantScopedClient(
    context.pool,
    scope(input),
    async (client) => {
      const role = await lockWorkspaceAuthority(
        client,
        input.workspaceId,
        input.actorId,
        rolesForCapability('workspace:read'),
      );
      if (!context.emailAvailable && input.mode !== 'off') {
        const current = await readNoticePreferences(client, input.workspaceId, {
          actorId: input.actorId,
          canManageDefaults: hasCapability(
            role,
            'notification:manage_defaults',
          ),
          emailAvailable: context.emailAvailable,
        });
        if (input.mode !== null || current.defaults.mode !== 'off')
          throw new NoticeUnavailableError(
            current.emailUnavailableReason ?? 'Email is unavailable.',
          );
      }
      return replacePreference(client, input, { defaults: false });
    },
    options(input),
  );
}

function replaceDefaultPreferences(
  context: NoticePreferenceContext,
  input: Parameters<NoticePreferencesStore['replaceDefaults']>[0],
): ReturnType<NoticePreferencesStore['replaceDefaults']> {
  return withTenantScopedClient(
    context.pool,
    scope(input),
    async (client) => {
      await lockWorkspaceAuthority(
        client,
        input.workspaceId,
        input.actorId,
        rolesForCapability('notification:manage_defaults'),
      );
      if (!context.emailAvailable && input.mode !== 'off')
        throw new NoticeUnavailableError(
          'Durable system mail is not configured.',
        );
      return replacePreference(client, input, { defaults: true });
    },
    options(input),
  );
}

function readPersonalSubscription(
  context: NoticePreferenceContext,
  input: Parameters<NoticePreferencesStore['readSubscription']>[0],
): ReturnType<NoticePreferencesStore['readSubscription']> {
  return withTenantScopedReadClient(
    context.pool,
    scope(input),
    async (client) => {
      await readWorkspaceAuthority(client, input.workspaceId, {
        actorId: input.actorId,
        roles: rolesForCapability('run:read'),
      });
      await subjectExists(client, input);
      const found = await client.query<NoticeSubscription>(
        'select revision,followed,muted from app.notice_subscriptions where workspace_id=$1 and user_id=$2 and subject_kind=$3 and subject_id=$4',
        [input.workspaceId, input.actorId, input.subjectKind, input.subjectId],
      );
      return found.rows[0] ?? { revision: 0, followed: false, muted: false };
    },
    options(input),
  );
}

function replacePersonalSubscription(
  context: NoticePreferenceContext,
  input: Parameters<NoticePreferencesStore['replaceSubscription']>[0],
): ReturnType<NoticePreferencesStore['replaceSubscription']> {
  return withTenantScopedClient(
    context.pool,
    scope(input),
    async (client) => {
      await lockWorkspaceAuthority(
        client,
        input.workspaceId,
        input.actorId,
        rolesForCapability('run:read'),
      );
      await subjectExists(client, input, { locking: true });
      if (input.subjectKind === 'connection' && input.followed)
        throw new NoticeUnavailableError('Only workflows can be followed.');
      return replaceSubscription(client, input);
    },
    options(input),
  );
}

function unsubscribePersonalMail(
  context: NoticePreferenceContext,
  input: Parameters<NoticePreferencesStore['unsubscribe']>[0],
): ReturnType<NoticePreferencesStore['unsubscribe']> {
  return withTenantScopedClient(context.pool, scope(input), async (client) => {
    await lockWorkspaceAuthority(
      client,
      input.workspaceId,
      input.actorId,
      rolesForCapability('workspace:read'),
    );
    const member = await client.query<{ role_revision: number }>(
      'select role_revision from app.workspace_memberships where workspace_id=$1 and user_id=$2',
      [input.workspaceId, input.actorId],
    );
    if (member.rows[0]?.role_revision !== input.memberRevision) return false;
    const found = await client.query<{
      revision: number;
      mode: string | null;
    }>(
      'select revision,mode from app.notice_preferences where workspace_id=$1 and user_id=$2 for update',
      [input.workspaceId, input.actorId],
    );
    const row = found.rows[0];
    if (row === undefined) return false;
    if (row.mode === 'off' && row.revision === input.revision + 1) return true;
    if (row.revision !== input.revision) return false;
    await client.query(
      "update app.notice_preferences set mode='off',revision=revision+1,changed_at=clock_timestamp(),next_due_at=null where workspace_id=$1 and user_id=$2",
      [input.workspaceId, input.actorId],
    );
    return true;
  });
}
type NoticePreferenceContext = Readonly<{
  pool: Pool;
  emailAvailable: boolean;
}>;
