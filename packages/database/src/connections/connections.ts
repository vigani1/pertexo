import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';

import type { DatabaseConfig } from '../config.js';
import { createConnectionHealthPersistence } from './connection-health-persistence.js';
import {
  createConnectionLookupPersistence,
  type ConnectionLookupDatabase,
} from './connection-lookup-persistence.js';
import { createConnectionManagementPersistence } from './connection-management-persistence.js';
import { createConnectionResolutionPersistence } from './connection-resolution-persistence.js';
import { createConnectionReadPersistence } from './connection-read-persistence.js';
import { createConnectionSecretPersistence } from './connection-secret-persistence.js';
import { createConnectionTestPersistence } from './connection-test-persistence.js';
import type {
  ConnectionDatabase,
  ConnectionManagementDatabase,
  ConnectionReadDatabase,
  ConnectionResolutionDatabase,
  ConnectionTestDatabase,
} from './connection-persistence.js';

/** API capability plus the lifecycle operation owned by its runtime factory. */
export type ApiConnectionDatabase = ConnectionManagementDatabase &
  ConnectionReadDatabase &
  ConnectionTestDatabase &
  ConnectionLookupDatabase &
  Pick<ConnectionDatabase, 'close'>;

/** Worker resolution capability plus the lifecycle operation owned by its runtime factory. */
export type WorkerConnectionResolutionDatabase = ConnectionResolutionDatabase &
  Pick<ConnectionDatabase, 'close'>;

export {
  CONNECTION_AUTH_TYPE,
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from './connection-persistence.js';
export type { ConnectionLookupDatabase } from './connection-lookup-persistence.js';
export type {
  AbandonConnectionTestInput,
  AssertConnectionSecretCurrentInput,
  CompleteConnectionTestInput,
  ConnectionAuthType,
  ConnectionDatabase,
  ConnectionManagementDatabase,
  ConnectionPage,
  ConnectionReadDatabase,
  ConnectionRecord,
  ConnectionResolutionDatabase,
  ConnectionStatus,
  ConnectionTestDatabase,
  ConnectionTestOutcome,
  ConnectionTestResult,
  CreateConnectionInput,
  FindConnectionCreateReplayInput,
  FindConnectionRotateReplayInput,
  ListConnectionsInput,
  MarkConnectionTestDispatchedInput,
  RecordConnectionHealthInput,
  ReadConnectionInput,
  ResolvedConnectionSecretRecord,
  ResolveConnectionSecretInput,
  ResolveConnectionTestSecretInput,
  RevokeConnectionInput,
  RotateConnectionSecretInput,
  SealedConnectionSecretRecord,
  StartConnectionTestInput,
  StartConnectionTestResult,
} from './connection-persistence.js';

export function createConnectionDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ConnectionDatabase & ConnectionLookupDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    ...createConnectionManagementPersistence(pool),
    ...createConnectionReadPersistence(pool),
    ...createConnectionSecretPersistence(pool),
    ...createConnectionResolutionPersistence(pool),
    ...createConnectionHealthPersistence(pool),
    ...createConnectionTestPersistence(pool),
    ...createConnectionLookupPersistence(pool),
    close: () => lease.close(),
  });
}

export function createApiConnectionDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ApiConnectionDatabase {
  const database = createConnectionDatabase(config, runtime);
  return Object.freeze({
    listConnections: database.listConnections.bind(database),
    readConnection: database.readConnection.bind(database),
    createConnection: database.createConnection.bind(database),
    findConnectionCreateReplay:
      database.findConnectionCreateReplay.bind(database),
    findConnectionRotateReplay:
      database.findConnectionRotateReplay.bind(database),
    rotateConnectionSecret: database.rotateConnectionSecret.bind(database),
    revokeConnection: database.revokeConnection.bind(database),
    startConnectionTest: database.startConnectionTest.bind(database),
    resolveConnectionTestSecret:
      database.resolveConnectionTestSecret.bind(database),
    markConnectionTestDispatched:
      database.markConnectionTestDispatched.bind(database),
    completeConnectionTest: database.completeConnectionTest.bind(database),
    abandonConnectionTest: database.abandonConnectionTest.bind(database),
    resolveConnectionLookupSecret:
      database.resolveConnectionLookupSecret.bind(database),
    close: database.close.bind(database),
  });
}

export function createWorkerConnectionResolutionDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkerConnectionResolutionDatabase {
  const database = createConnectionDatabase(config, runtime);
  return Object.freeze({
    assertConnectionSecretCurrent:
      database.assertConnectionSecretCurrent.bind(database),
    resolveConnectionSecret: database.resolveConnectionSecret.bind(database),
    close: database.close.bind(database),
  });
}
