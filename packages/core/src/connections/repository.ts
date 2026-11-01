import type { WorkerConnectionResolutionDatabase } from './runtime/contract.js';
import { createConnectionSharingPersistence } from './commands/sharing.repository.js';
import type { ConnectionSharingDatabase } from './commands/contract.js';
import { acquireDatabasePool } from '@pertexo/database/platform';
import type {
  DatabaseRuntime,
  DatabaseConfig,
} from '@pertexo/database/platform';

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
import { createOAuth2AuthorizationPersistence } from './oauth2/authorizations.repository.js';
import { createOAuth2TokenPersistence } from './oauth2/tokens.repository.js';
import type {
  OAuth2ConsentDatabase,
  OAuth2TokenStoreDatabase,
} from './oauth2/contract.js';

export function createConnectionDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ConnectionDatabase &
  ConnectionLookupDatabase &
  ConnectionUsageDatabase &
  ConnectionSharingDatabase &
  OAuth2ConsentDatabase &
  OAuth2TokenStoreDatabase {
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
    ...createOAuth2AuthorizationPersistence(pool),
    ...createOAuth2TokenPersistence(pool),
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
    openOAuth2Grant: database.openOAuth2Grant,
    readOAuth2Token: database.readOAuth2Token,
    claimOAuth2Refresh: database.claimOAuth2Refresh,
    blockOAuth2Refresh: database.blockOAuth2Refresh,
    commitOAuth2Refresh: database.commitOAuth2Refresh,
    loseOAuth2Grant: database.loseOAuth2Grant,
    rejectOAuth2Token: database.rejectOAuth2Token,
    close: database.close.bind(database),
  });
}
