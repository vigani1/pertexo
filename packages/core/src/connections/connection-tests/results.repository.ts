import type { Pool } from 'pg';
import type { ConnectionTestPersistence } from './contract.js';

import { markConnectionTestDispatched } from './dispatch.repository.js';

import { abandonPersistedConnectionTest } from './abandon.repository.js';
import { completePersistedConnectionTest } from './complete.repository.js';
import { resolvePersistedConnectionTestSecret } from './secret.queries.js';
import { startPersistedConnectionTest } from './start.repository.js';
export { classifyConnectionTestCompletion } from '@pertexo/workflow-model';

export function createConnectionTestPersistence(
  pool: Pool,
): ConnectionTestPersistence {
  return Object.freeze({
    startConnectionTest: (input) => startPersistedConnectionTest(pool, input),

    resolveConnectionTestSecret: (input) =>
      resolvePersistedConnectionTestSecret(pool, input),

    markConnectionTestDispatched: (input) => {
      return markConnectionTestDispatched(pool, input);
    },

    completeConnectionTest: (input) =>
      completePersistedConnectionTest(pool, input),

    abandonConnectionTest: (input) =>
      abandonPersistedConnectionTest(pool, input),
  });
}
