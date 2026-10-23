import { sql } from 'drizzle-orm';
import { readFolderScope } from '../../tenant-access/resources/facts.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../tenant-access/resources/query-scope.js';
import type { PoolClient } from 'pg';
import { noticeSubscriptionSchema } from '@pertexo/contracts';
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
  locking = false,
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
  emailAvailable: boolean,
  runtime?: DatabaseRuntime,
): NoticePreferencesStore {
  const lease = acquireDatabasePool(config, runtime);
  const scope = (input: NoticeReader) => ({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
  });
  const options = (input: NoticeReader) =>
    input.signal === undefined ? {} : { signal: input.signal };
  return {
    close: () => lease.close(),
    read: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        scope(input),
        async (client) => {
          const role = await readWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('workspace:read'),
          );
          return readNoticePreferences(
            client,
            input.workspaceId,
            input.actorId,
            hasCapability(role, 'notification:manage_defaults'),
            emailAvailable,
          );
        },
        options(input),
      ),
    replace: (input) =>
      withTenantScopedClient(
        lease.pool,
        scope(input),
        async (client) => {
          const role = await lockWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('workspace:read'),
          );
          if (!emailAvailable && input.mode !== 'off') {
            const current = await readNoticePreferences(
              client,
              input.workspaceId,
              input.actorId,
              hasCapability(role, 'notification:manage_defaults'),
              emailAvailable,
            );
            if (input.mode !== null || current.defaults.mode !== 'off')
              throw new NoticeUnavailableError(
                current.emailUnavailableReason ?? 'Email is unavailable.',
              );
          }
          return replacePreference(client, input, false);
        },
        options(input),
      ),
    replaceDefaults: (input) =>
      withTenantScopedClient(
        lease.pool,
        scope(input),
        async (client) => {
          await lockWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('notification:manage_defaults'),
          );
          if (!emailAvailable && input.mode !== 'off')
            throw new NoticeUnavailableError(
              'Durable system mail is not configured.',
            );
          return replacePreference(client, input, true);
        },
        options(input),
      ),
    readSubscription: (input) =>
      withTenantScopedReadClient(
        lease.pool,
        scope(input),
        async (client) => {
          await readWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('run:read'),
          );
          await subjectExists(client, input);
          const found = await client.query(
            'select revision,followed,muted from app.notice_subscriptions where workspace_id=$1 and user_id=$2 and subject_kind=$3 and subject_id=$4',
            [
              input.workspaceId,
              input.actorId,
              input.subjectKind,
              input.subjectId,
            ],
          );
          return noticeSubscriptionSchema.parse(
            found.rows[0] ?? { revision: 0, followed: false, muted: false },
          );
        },
        options(input),
      ),
    replaceSubscription: (input) =>
      withTenantScopedClient(
        lease.pool,
        scope(input),
        async (client) => {
          await lockWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('run:read'),
          );
          await subjectExists(client, input, true);
          if (input.subjectKind === 'connection' && input.followed)
            throw new NoticeUnavailableError('Only workflows can be followed.');
          return replaceSubscription(client, input);
        },
        options(input),
      ),
    unsubscribe: (input) =>
      withTenantScopedClient(lease.pool, scope(input), async (client) => {
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
        if (member.rows[0]?.role_revision !== input.memberRevision)
          return false;
        const found = await client.query<{
          revision: number;
          mode: string | null;
        }>(
          'select revision,mode from app.notice_preferences where workspace_id=$1 and user_id=$2 for update',
          [input.workspaceId, input.actorId],
        );
        const row = found.rows[0];
        if (row === undefined) return false;
        if (row.mode === 'off' && row.revision === input.revision + 1)
          return true;
        if (row.revision !== input.revision) return false;
        await client.query(
          "update app.notice_preferences set mode='off',revision=revision+1,changed_at=clock_timestamp(),next_due_at=null where workspace_id=$1 and user_id=$2",
          [input.workspaceId, input.actorId],
        );
        return true;
      }),
  };
}
