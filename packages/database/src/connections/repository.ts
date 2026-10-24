import type { WorkerConnectionResolutionDatabase } from './runtime/contract.js';
import { createConnectionSharingPersistence } from './commands/sharing.repository.js';
import type { ConnectionSharingDatabase } from './commands/contract.js';
import { acquireDatabasePool } from '../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../platform/pool/runtime.js';

import type { DatabaseConfig } from '../config.js';
import { createConnectionLookupPersistence } from './runtime/lookup.repository.js';
import type { ConnectionLookupDatabase } from './runtime/contract.js';
import { createConnectionManagementPersistence } from './commands/management.repository.js';
import { createConnectionResolutionPersistence } from './runtime/secrets.repository.js';
import { createConnectionReadPersistence } from './discovery/reads.queries.js';
import { createConnectionUsagePersistence } from './discovery/usage.queries.js';
import type { ConnectionUsageDatabase } from './discovery/contract.js';
import { createConnectionSecretPersistence } from './commands/secrets.repository.js';
import { createConnectionTestPersistence } from './connection-tests/results.repository.js';
import type { ConnectionDatabase } from './contract.js';

export function createConnectionDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ConnectionDatabase &
  ConnectionLookupDatabase &
  ConnectionUsageDatabase &
  ConnectionSharingDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    ...createConnectionSharingPersistence(pool),
    ...createConnectionManagementPersistence(pool),
    ...createConnectionReadPersistence(pool),
    ...createConnectionUsagePersistence(pool),
    ...createConnectionSecretPersistence(pool),
    ...createConnectionResolutionPersistence(pool),
    ...createConnectionTestPersistence(pool),
    ...createConnectionLookupPersistence(pool),
    close: () => lease.close(),
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
