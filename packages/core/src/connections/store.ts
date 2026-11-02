import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type Role,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import {
  withWorkspaceAccess,
  type WorkspaceAccess,
  type WorkspaceActor,
} from '../shared/workspace-access.js';
import { WorkspaceAccessDeniedError } from '../shared/errors.js';
import type {
  ReadConnectionSharingInput,
  ReplaceConnectionSharingInput,
} from './commands/contract.js';
import {
  createConnection,
  findConnectionCreateReplay,
  revokeConnection,
} from './commands/manage.repository.js';
import {
  findConnectionRotateReplay,
  rotateConnectionSecret,
} from './commands/rotate.repository.js';
import {
  readConnectionSharing,
  replaceConnectionSharing,
} from './commands/sharing.repository.js';
import { abandonConnectionTest } from './connection-tests/abandon.repository.js';
import { completeConnectionTest } from './connection-tests/complete.repository.js';
import { markConnectionTestDispatched } from './connection-tests/dispatch.repository.js';
import { resolveConnectionTestSecret } from './connection-tests/resolve-secret.repository.js';
import { startConnectionTest } from './connection-tests/start.repository.js';
import type {
  AbandonConnectionTestInput,
  AssertConnectionSecretCurrentInput,
  CompleteConnectionTestInput,
  CreateConnectionInput,
  FindConnectionCreateReplayInput,
  FindConnectionRotateReplayInput,
  ListConnectionsInput,
  MarkConnectionTestDispatchedInput,
  ReadConnectionInput,
  ResolveConnectionSecretInput,
  ResolveConnectionTestSecretInput,
  RevokeConnectionInput,
  RotateConnectionSecretInput,
  StartConnectionTestInput,
} from './contract.js';
import { ConnectionNotFoundError } from './contract.js';
import type { ListConnectionUsageInput } from './discovery/contract.js';
import { listConnections, readConnection } from './discovery/reads.queries.js';
import { listConnectionUsage } from './discovery/usage.queries.js';
import {
  authorizeOAuth2Connection,
  consumeOAuth2Authorization,
  readOAuth2Client,
  startOAuth2Authorization,
} from './oauth2/authorizations.repository.js';
import type {
  AuthorizeOAuth2ConnectionInput,
  ConsumeOAuth2AuthorizationInput,
  ReadOAuth2ClientInput,
  ReadOAuth2EarlierTokensInput,
  StartOAuth2AuthorizationInput,
} from './oauth2/contract.js';
import {
  oauth2TokenFlows,
  readEarlierTokens,
} from './oauth2/tokens.repository.js';
import {
  requireVisibleConnection,
  selectConnection,
} from './records.queries.js';
import type { ResolveConnectionLookupSecretInput } from './runtime/contract.js';
import { resolveConnectionLookupSecret } from './runtime/lookup.repository.js';
import {
  assertConnectionSecretCurrent,
  resolveConnectionSecret,
} from './runtime/resolve.repository.js';
import { withConnectionTransaction } from './transaction.js';

export type ConnectionStore = ReturnType<typeof createConnectionStore>;

export function createConnectionStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  /** Someone without access sees "not found" rather than learning it exists. */
  const access = async <T>(
    actor: WorkspaceActor,
    rule: WorkspaceAccess,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ): Promise<T> => {
    try {
      return await withWorkspaceAccess(pool, actor, rule, work);
    } catch (error) {
      if (error instanceof WorkspaceAccessDeniedError)
        throw new ConnectionNotFoundError('Connection is not visible');
      return rethrowQueryFailure(error);
    }
  };
  const manage = <T>(
    actor: WorkspaceActor,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    access(
      actor,
      {
        mode: 'change',
        capability: 'connection:manage',
        statuses: ACTIVE_WORKSPACE_STATUSES,
      },
      work,
    );
  /** These reads lock too, and a suspended workspace can still be browsed. */
  const browse = <T>(
    actor: WorkspaceActor,
    work: (client: PoolClient, role: Role) => Promise<T>,
  ) =>
    access(
      actor,
      {
        mode: 'change',
        capability: 'connection:read',
        statuses: BROWSABLE_WORKSPACE_STATUSES,
      },
      work,
    );
  /** Using a connection also needs its own shares to reach this member. */
  const use = <T>(
    actor: WorkspaceActor & Readonly<{ connectionId: string }>,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    access(
      actor,
      {
        mode: 'change',
        capability: 'connection:use',
        statuses: ACTIVE_WORKSPACE_STATUSES,
      },
      async (client, role) => {
        await requireVisibleConnection(client, actor, role, 'connection:use');
        return work(client);
      },
    );
  return Object.freeze({
    createConnection: (input: CreateConnectionInput) =>
      manage(input, (client) => createConnection(client, input)),
    findConnectionCreateReplay: (input: FindConnectionCreateReplayInput) =>
      manage(input, (client) => findConnectionCreateReplay(client, input)),
    findConnectionRotateReplay: (input: FindConnectionRotateReplayInput) =>
      manage(input, (client) => findConnectionRotateReplay(client, input)),
    rotateConnectionSecret: (input: RotateConnectionSecretInput) =>
      manage(input, (client) => rotateConnectionSecret(client, input)),
    revokeConnection: (input: RevokeConnectionInput) =>
      manage(input, (client) => revokeConnection(client, input)),
    readConnectionSharing: (input: ReadConnectionSharingInput) =>
      manage(input, (client) => readConnectionSharing(client, input)),
    /** Shares change one at a time per workspace, so concurrent edits can't deadlock. */
    replaceConnectionSharing: (input: ReplaceConnectionSharingInput) =>
      access(
        input,
        {
          mode: 'exclusive',
          capability: 'connection:manage',
          statuses: ACTIVE_WORKSPACE_STATUSES,
        },
        (client) => replaceConnectionSharing(client, input),
      ),
    listConnections: (input: ListConnectionsInput) =>
      browse(input, (client, role) => listConnections(client, input, role)),
    readConnection: (input: ReadConnectionInput) =>
      browse(input, (client, role) => readConnection(client, input, role)),
    listConnectionUsage: (input: ListConnectionUsageInput) =>
      browse(input, (client, role) => listConnectionUsage(client, input, role)),
    startConnectionTest: (input: StartConnectionTestInput) =>
      use(input, (client) => startConnectionTest(client, input)),
    resolveConnectionTestSecret: (input: ResolveConnectionTestSecretInput) =>
      use(input, (client) => resolveConnectionTestSecret(client, input)),
    markConnectionTestDispatched: (input: MarkConnectionTestDispatchedInput) =>
      use(input, (client) => markConnectionTestDispatched(client, input)),
    completeConnectionTest: (input: CompleteConnectionTestInput) =>
      completeConnectionTest(pool, input),
    abandonConnectionTest: (input: AbandonConnectionTestInput) =>
      abandonConnectionTest(pool, input),
    resolveConnectionLookupSecret: (
      input: ResolveConnectionLookupSecretInput,
    ) => use(input, (client) => resolveConnectionLookupSecret(client, input)),
    resolveConnectionSecret: (input: ResolveConnectionSecretInput) =>
      resolveConnectionSecret(pool, input),
    assertConnectionSecretCurrent: (
      input: AssertConnectionSecretCurrentInput,
    ) => assertConnectionSecretCurrent(pool, input),
    /** No member: for a caller that already holds the connection's identity. */
    getConnection: (workspaceId: string, connectionId: string) =>
      withConnectionTransaction(pool, { workspaceId }, (client) =>
        selectConnection(client, workspaceId, connectionId),
      ),
    readOAuth2Client: (input: ReadOAuth2ClientInput) =>
      manage(input, (client) => readOAuth2Client(client, input)),
    startOAuth2Authorization: (input: StartOAuth2AuthorizationInput) =>
      manage(input, (client) => startOAuth2Authorization(client, input)),
    consumeOAuth2Authorization: (input: ConsumeOAuth2AuthorizationInput) =>
      consumeOAuth2Authorization(pool, input),
    readOAuth2EarlierTokens: (input: ReadOAuth2EarlierTokensInput) =>
      readEarlierTokens(pool, input),
    authorizeOAuth2Connection: (input: AuthorizeOAuth2ConnectionInput) =>
      authorizeOAuth2Connection(pool, input),
    ...oauth2TokenFlows(pool),
    close: () => lease.close(),
  });
}

/** API connection commands and their idempotency lookups. */
export type ConnectionManagementStore = Pick<
  ConnectionStore,
  | 'createConnection'
  | 'findConnectionCreateReplay'
  | 'findConnectionRotateReplay'
  | 'rotateConnectionSecret'
  | 'revokeConnection'
>;

/** Safe metadata reads for authenticated API consumers. */
export type ConnectionReadStore = Pick<
  ConnectionStore,
  'listConnections' | 'readConnection'
>;

/** API-owned connection-test state transitions. */
export type ConnectionTestStore = Pick<
  ConnectionStore,
  | 'startConnectionTest'
  | 'resolveConnectionTestSecret'
  | 'markConnectionTestDispatched'
  | 'completeConnectionTest'
  | 'abandonConnectionTest'
>;

export type ConnectionLookupStore = Pick<
  ConnectionStore,
  'resolveConnectionLookupSecret'
>;

export type ConnectionUsageStore = Pick<ConnectionStore, 'listConnectionUsage'>;

export type ConnectionSharingStore = Pick<
  ConnectionStore,
  'readConnectionSharing' | 'replaceConnectionSharing'
>;

export type OAuth2ConsentStore = Pick<
  ConnectionStore,
  | 'readOAuth2Client'
  | 'startOAuth2Authorization'
  | 'consumeOAuth2Authorization'
  | 'readOAuth2EarlierTokens'
  | 'authorizeOAuth2Connection'
>;

/** The only connection behavior required by a worker node executor. */
export type ConnectionResolutionStore = Pick<
  ConnectionStore,
  'assertConnectionSecretCurrent' | 'resolveConnectionSecret'
>;

/** Everything but what only a worker may do: resolving a secret for a run. */
export type ApiConnectionStore = Omit<
  ConnectionStore,
  'assertConnectionSecretCurrent' | 'resolveConnectionSecret' | 'getConnection'
>;

export type WorkerConnectionResolutionStore = ReturnType<
  typeof createWorkerConnectionResolutionStore
>;

export function createWorkerConnectionResolutionStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const store = createConnectionStore(config, runtime);
  return Object.freeze({
    assertConnectionSecretCurrent: store.assertConnectionSecretCurrent,
    resolveConnectionSecret: store.resolveConnectionSecret,
    openOAuth2Grant: store.openOAuth2Grant,
    readOAuth2Token: store.readOAuth2Token,
    claimOAuth2Refresh: store.claimOAuth2Refresh,
    blockOAuth2Refresh: store.blockOAuth2Refresh,
    commitOAuth2Refresh: store.commitOAuth2Refresh,
    loseOAuth2Grant: store.loseOAuth2Grant,
    rejectOAuth2Token: store.rejectOAuth2Token,
    close: store.close,
  });
}
