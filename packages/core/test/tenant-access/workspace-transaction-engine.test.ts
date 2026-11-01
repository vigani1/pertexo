import { describe } from 'vitest';

import { registerRejectsInvalidPostgreSQLStatementTimeout } from './workspace-transaction-engine/statement-timeouts.cases.js';
import { registerRejectsDestroysClientRetainingActor } from './workspace-transaction-engine/rejects-destroys-client-retaining-actor.cases.js';
import { registerExposesImmutableWorkspaceTransactionParsed } from './workspace-transaction-engine/exposes-immutable-workspace-transaction-parsed.cases.js';
import { registerStartsNoCallbackLaterSQL } from './workspace-transaction-engine/starts-no-callback-later-sql.cases.js';
import { registerReleasesAcquiredClientAbortWins } from './workspace-transaction-engine/releases-acquired-client-abort-wins.cases.js';
describe('shared workspace transaction engine', () => {
  registerRejectsInvalidPostgreSQLStatementTimeout();

  registerRejectsDestroysClientRetainingActor();

  registerExposesImmutableWorkspaceTransactionParsed();

  registerStartsNoCallbackLaterSQL();

  registerReleasesAcquiredClientAbortWins();
});
