import { requireWorkspaceAuthority } from '../../shared/access/workspace-access.errors.js';
import { rolesForCapability } from '@pertexo/policy';

import type { Pool, PoolClient } from 'pg';

import { withTenantScopedClient } from '@pertexo/database/primitives';

import { WorkspaceAccessDeniedError } from '../../shared/access/workspace-access.errors.js';

import { lockWorkspaceAuthority } from '../../shared/access/workspace-authority.js';

import type { ConnectionRecord } from '../connection.types.js';

import {
  CONNECTION_AUTH_TYPE,
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
} from '@pertexo/workflow-model';

import {
  ConnectionNotFoundError,
  ConnectionNotOAuth2Error,
  ConnectionUnavailableError,
} from '../connection.errors.js';

import { recordMemberAction } from '../events.repository.js';

import { selectConnection } from '../connections.repository.js';

import { withConnectionTransaction } from '../transaction.js';

import { withOneOAuth2Fact } from './clients.repository.js';

import type {
  AuthorizeOAuth2ConnectionInput,
  ConsumedOAuth2Authorization,
  ConsumeOAuth2AuthorizationInput,
  OAuth2ClientRecord,
  ReadOAuth2ClientInput,
  StartOAuth2AuthorizationInput,
} from './oauth2-grant.types.js';
import {
  consumeAuthorizationState,
  markOAuth2Authorized,
  replaceTokenRow,
  selectClient,
  shareLockWorkspaceStatus,
  upsertAuthorization,
} from './authorizations.repository.js';

/** Only a connection that can still be connected may start consent. */
function requireConnectable(
  connection: ConnectionRecord | null,
): ConnectionRecord {
  if (connection === null)
    throw new ConnectionNotFoundError('Connection is not visible');
  if (connection.authType !== CONNECTION_AUTH_TYPE.oauth2)
    throw new ConnectionNotOAuth2Error('Connection does not use OAuth2');
  if (connection.status === CONNECTION_STATUS.revoked)
    throw new ConnectionUnavailableError('Connection is revoked');
  return connection;
}

export async function readOAuth2Client(
  client: PoolClient,
  input: ReadOAuth2ClientInput,
): Promise<OAuth2ClientRecord> {
  const { workspaceId } = input;
  const connection = requireConnectable(
    await selectConnection(client, workspaceId, input.connectionId),
  );
  const row = await selectClient(
    client,
    workspaceId,
    input.connectionId,
    connection.currentSecretVersionId,
  );
  if (row === undefined)
    throw new Error('OAuth2 connection has no client for its version');
  return Object.freeze({
    connection: await withOneOAuth2Fact(client, workspaceId, connection),
    settings: row.settings,
    clientSecret: row.clientSecret,
  });
}

export async function startOAuth2Authorization(
  client: PoolClient,
  input: StartOAuth2AuthorizationInput,
): Promise<Readonly<{ expiresAt: Date }>> {
  const { workspaceId } = input;
  const connection = requireConnectable(
    await selectConnection(client, workspaceId, input.connectionId, {
      lock: true,
    }),
  );
  if (connection.currentSecretVersionId !== input.secretVersionId)
    throw new ConnectionUnavailableError(
      'Connection settings changed',
      'settings_changed',
    );
  return upsertAuthorization(client, input);
}

/**
 * One statement decides who holds a state: two callbacks can't both consume it,
 * and a browser without the binding cookie leaves the row for the one that has it.
 * The callback has no session member: authority is checked for whoever started
 * consent, after the state is consumed, so it stays off `withWorkspaceAccess`.
 */
export async function consumeOAuth2Authorization(
  pool: Pool,
  input: ConsumeOAuth2AuthorizationInput,
): Promise<ConsumedOAuth2Authorization> {
  if (input.bindingDigests.length === 0) return { kind: 'unknown' };
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId },
    async (client): Promise<ConsumedOAuth2Authorization> => {
      const row = await consumeAuthorizationState(client, input);
      if (row === undefined) return { kind: 'unknown' };
      const refused = {
        kind: 'refused',
        connectionId: row.connectionId,
      } as const;
      try {
        requireWorkspaceAuthority(
          await lockWorkspaceAuthority(
            client,
            input.workspaceId,
            row.startedBy,
            rolesForCapability('connection:manage'),
          ),
        );
      } catch (error: unknown) {
        if (error instanceof WorkspaceAccessDeniedError) return refused;
        throw error;
      }
      const connection = await selectConnection(
        client,
        input.workspaceId,
        row.connectionId,
      );
      if (
        connection === null ||
        connection.status === CONNECTION_STATUS.revoked ||
        connection.currentSecretVersionId !== row.secretVersionId
      )
        return refused;
      const stored = await selectClient(
        client,
        input.workspaceId,
        row.connectionId,
        row.secretVersionId,
      );
      if (stored === undefined) return refused;
      return Object.freeze({
        kind: 'consumed',
        connectionId: row.connectionId,
        startedBy: row.startedBy,
        secretVersionId: row.secretVersionId,
        settings: stored.settings,
        clientSecret: stored.clientSecret,
      });
    },
  );
}

/**
 * Consent or a server-to-server start succeeded. It answers for the settings it
 * ran with: replaced or revoked since then, the new tokens are discarded.
 */
export async function authorizeOAuth2Connection(
  pool: Pool,
  input: AuthorizeOAuth2ConnectionInput,
): Promise<ConnectionRecord | null> {
  const { workspaceId } = input;
  return withConnectionTransaction(pool, { workspaceId }, async (client) => {
    // Deletion may have been requested during the exchange. Shared, so it can't
    // commit between this check and the insert and leave tokens behind.
    const workspaceStatus = await shareLockWorkspaceStatus(client, workspaceId);
    if (workspaceStatus !== 'active') return null;
    const current = await selectConnection(
      client,
      workspaceId,
      input.connectionId,
      { lock: true },
    );
    if (
      current === null ||
      current.status === CONNECTION_STATUS.revoked ||
      current.currentSecretVersionId !== input.secretVersionId
    )
      return null;
    await replaceTokenRow(client, workspaceId, input);
    const row = await markOAuth2Authorized(
      client,
      workspaceId,
      input.connectionId,
    );
    await recordMemberAction(client, {
      workspaceId,
      connectionId: input.connectionId,
      eventType: CONNECTION_EVENT_TYPE.oauth2Authorized,
      actorId: input.actorId,
      requestId: input.requestId,
      traceId: input.traceId,
      metadata: { secretVersionId: input.secretVersionId },
    });
    return withOneOAuth2Fact(client, workspaceId, row);
  });
}
