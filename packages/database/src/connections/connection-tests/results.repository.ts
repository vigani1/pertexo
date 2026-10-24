import type { Pool } from 'pg';

import { markConnectionTestDispatched } from './dispatch.repository.js';

import type { ConnectionDatabase } from '../records.queries.js';

import { startPersistedConnectionTest } from './start.repository.js';
import { resolvePersistedConnectionTestSecret } from './secret.queries.js';
import { completePersistedConnectionTest } from './complete.repository.js';
import { abandonPersistedConnectionTest } from './abandon.repository.js';
export { classifyConnectionTestCompletion } from './classify-completion.js';

/** Owns connection-test claim, dispatch, completion, and abandonment. */

export type ConnectionTestPersistence = Pick<
  ConnectionDatabase,
  | 'startConnectionTest'
  | 'resolveConnectionTestSecret'
  | 'markConnectionTestDispatched'
  | 'completeConnectionTest'
  | 'abandonConnectionTest'
>;

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
