import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  noticePreferences,
  noticeSubscriptions,
} from '../../schema/inbox/preferences.js';
import { workspaceMemberships } from '../../schema/foundation.js';
import { workflows } from '../../schema/authoring/workflows.js';
import { connections } from '../../schema/connections.js';
import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import { workflowScopeSql } from '../../tenant-access/resources/scope.queries.js';
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
} from '../../tenant-access/workspaces/authority.queries.js';
import { hasCapability, rolesForCapability } from '@pertexo/workflow-model';
import {
  NoticeUnavailableError,
  type NoticePreferencesStore,
  type NoticeReader,
  type NoticeSubject,
} from './contract.js';
import { readNoticePreferences } from './settings.queries.js';
import {
  replacePreference,
  replaceSubscription,
} from './commands.repository.js';
async function subjectExists(
  client: PoolClient,
  input: NoticeReader & NoticeSubject,
  { locking = false }: Readonly<{ locking?: boolean | undefined }> = {},
) {
  const db = drizzle(client);
  const table = input.subjectKind === 'workflow' ? workflows : connections;
  const visible =
    input.subjectKind === 'workflow'
      ? workflowScopeSql(
          await readFolderScope(client, input),
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
  const found = await (locking ? query.for('share') : query);
  if (found.length !== 1)
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
      return replacePreference(client, { input, defaults: false });
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
      return replacePreference(client, { input, defaults: true });
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
    const db = drizzle(client);
    const [member] = await db
      .select({ roleRevision: workspaceMemberships.roleRevision })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          eq(workspaceMemberships.userId, input.actorId),
        ),
      )
      .catch(rethrowQueryFailure);
    if (member?.roleRevision !== input.memberRevision) return false;
    const predicate = and(
      eq(noticePreferences.workspaceId, input.workspaceId),
      eq(noticePreferences.userId, input.actorId),
    );
    const [row] = await db
      .select({
        revision: noticePreferences.revision,
        mode: noticePreferences.mode,
      })
      .from(noticePreferences)
      .where(predicate)
      .for('update')
      .catch(rethrowQueryFailure);
    if (row === undefined) return false;
    if (row.mode === 'off' && row.revision === input.revision + 1) return true;
    if (row.revision !== input.revision) return false;
    await db
      .update(noticePreferences)
      .set({
        mode: 'off',
        revision: row.revision + 1,
        changedAt: sql`clock_timestamp()`,
        nextDueAt: null,
      })
      .where(predicate)
      .catch(rethrowQueryFailure);
    return true;
  });
}
type NoticePreferenceContext = Readonly<{
  pool: Pool;
  emailAvailable: boolean;
}>;
