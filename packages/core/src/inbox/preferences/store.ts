import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import type { NoticeCommandResponse } from '@pertexo/contracts';
import { hasCapability } from '@pertexo/workflow-model';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type Role,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../../shared/workspace-access.js';
import {
  NoticeUnavailableError,
  type ReadNoticeSubscriptionInput,
  type ReplaceNoticeDefaultsInput,
  type ReplaceNoticePreferencesInput,
  type ReplaceNoticeSubscriptionInput,
  type UnsubscribeNoticeMailInput,
} from './contract.js';
import {
  replacePreference,
  replaceSubscription,
} from './replace.repository.js';
import { readNoticePreferences } from './settings.queries.js';
import { readSubscription, requireSubject } from './subscriptions.queries.js';
import { unsubscribeMail } from './unsubscribe.repository.js';

export type NoticePreferencesStore = ReturnType<
  typeof createNoticePreferencesStore
>;

export function createNoticePreferencesStore(
  config: DatabaseConfig,
  {
    emailAvailable,
    runtime,
  }: Readonly<{
    emailAvailable: boolean;
    runtime?: DatabaseRuntime | undefined;
  }>,
) {
  const lease = acquireDatabasePool(config, runtime);
  const read = <T>(
    actor: WorkspaceActor,
    capability: AuthorizationCapability,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ) =>
    withWorkspaceAccess(
      lease.pool,
      actor,
      { mode: 'read', capability, statuses: BROWSABLE_WORKSPACE_STATUSES },
      work,
    );
  const change = <T>(
    actor: WorkspaceActor,
    capability: AuthorizationCapability,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ) =>
    withWorkspaceAccess(
      lease.pool,
      actor,
      { mode: 'change', capability, statuses: ACTIVE_WORKSPACE_STATUSES },
      work,
    );
  const readPreferences = (
    client: PoolClient,
    { workspaceId, actorId }: WorkspaceActor,
    role: Role,
  ) =>
    readNoticePreferences(client, workspaceId, {
      actorId,
      canManageDefaults: hasCapability(role, 'notification:manage_defaults'),
      emailAvailable,
    });
  return {
    close: () => lease.close(),
    read: (input: WorkspaceActor) =>
      read(input, 'workspace:read', (client, role) =>
        readPreferences(client, input, role),
      ),
    replace: (
      input: ReplaceNoticePreferencesInput,
    ): Promise<NoticeCommandResponse> =>
      change(input, 'workspace:read', async (client, role) => {
        if (!emailAvailable && input.mode !== 'off') {
          const current = await readPreferences(client, input, role);
          if (input.mode !== null || current.defaults.mode !== 'off')
            throw new NoticeUnavailableError(
              current.emailUnavailableReason ?? 'Email is unavailable.',
            );
        }
        return replacePreference(client, { input, defaults: false });
      }),
    replaceDefaults: (
      input: ReplaceNoticeDefaultsInput,
    ): Promise<NoticeCommandResponse> =>
      change(input, 'notification:manage_defaults', async (client) => {
        if (!emailAvailable && input.mode !== 'off')
          throw new NoticeUnavailableError(
            'Durable system mail is not configured.',
          );
        return replacePreference(client, { input, defaults: true });
      }),
    readSubscription: (input: ReadNoticeSubscriptionInput) =>
      read(input, 'run:read', async (client, role) => {
        await requireSubject(client, input, role, { locking: false });
        return readSubscription(client, input);
      }),
    replaceSubscription: (
      input: ReplaceNoticeSubscriptionInput,
    ): Promise<NoticeCommandResponse> =>
      change(input, 'run:read', async (client, role) => {
        await requireSubject(client, input, role, { locking: true });
        if (input.subjectKind === 'connection' && input.followed)
          throw new NoticeUnavailableError('Only workflows can be followed.');
        return replaceSubscription(client, input);
      }),
    unsubscribe: (input: UnsubscribeNoticeMailInput) =>
      change(input, 'workspace:read', (client) =>
        unsubscribeMail(client, input),
      ),
  };
}
