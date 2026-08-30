import { createDatabasePool } from './postgres-telemetry.js';

import type { DatabaseConfig } from './config.js';
import { createConnectionHealthPersistence } from './connection-health-persistence.js';
import { createConnectionManagementPersistence } from './connection-management-persistence.js';
import { createConnectionResolutionPersistence } from './connection-resolution-persistence.js';
import { createConnectionSecretPersistence } from './connection-secret-persistence.js';
import { createConnectionTestPersistence } from './connection-test-persistence.js';
import type {
  ApiConnectionDatabase,
  ConnectionDatabase,
  WorkerConnectionResolutionDatabase,
} from './connection-persistence.js';

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
export type {
  AbandonConnectionTestInput,
  ApiConnectionDatabase,
  AssertConnectionSecretCurrentInput,
  CompleteConnectionTestInput,
  ConnectionAuthType,
  ConnectionDatabase,
  ConnectionManagementDatabase,
  ConnectionRecord,
  ConnectionResolutionDatabase,
  ConnectionStatus,
  ConnectionTestDatabase,
  ConnectionTestOutcome,
  ConnectionTestResult,
  CreateConnectionInput,
  FindConnectionCreateReplayInput,
  FindConnectionRotateReplayInput,
  MarkConnectionTestDispatchedInput,
  RecordConnectionHealthInput,
  ResolvedConnectionSecretRecord,
  ResolveConnectionSecretInput,
  ResolveConnectionTestSecretInput,
  RevokeConnectionInput,
  RotateConnectionSecretInput,
  SealedConnectionSecretRecord,
  StartConnectionTestInput,
  StartConnectionTestResult,
  WorkerConnectionResolutionDatabase,
} from './connection-persistence.js';

export function createConnectionDatabase(
  config: DatabaseConfig,
): ConnectionDatabase {
  const pool = createDatabasePool(config);
  return Object.freeze({
    ...createConnectionManagementPersistence(pool),
    ...createConnectionSecretPersistence(pool),
    ...createConnectionResolutionPersistence(pool),
    ...createConnectionHealthPersistence(pool),
    ...createConnectionTestPersistence(pool),
    close: () => pool.end(),
  });
}

export function createApiConnectionDatabase(
  config: DatabaseConfig,
): ApiConnectionDatabase {
  const database = createConnectionDatabase(config);
  return Object.freeze({
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
    close: database.close.bind(database),
  });
}

export function createWorkerConnectionResolutionDatabase(
  config: DatabaseConfig,
): WorkerConnectionResolutionDatabase {
  const database = createConnectionDatabase(config);
  return Object.freeze({
    assertConnectionSecretCurrent:
      database.assertConnectionSecretCurrent.bind(database),
    resolveConnectionSecret: database.resolveConnectionSecret.bind(database),
    close: database.close.bind(database),
  });
}
