import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  failUnadvanceableRun,
  type FailUnadvanceableInput,
} from './fail-unadvanceable.repository.js';

export type RunFailureStore = ReturnType<typeof createRunFailureStore>;

export function createRunFailureStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    /** For a run that can never move: ends it with this reason. */
    failUnadvanceable: (input: FailUnadvanceableInput) =>
      failUnadvanceableRun(lease.pool, input),
    close: () => lease.close(),
  });
}
