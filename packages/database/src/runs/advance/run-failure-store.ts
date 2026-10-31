import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import type { CoordinatorAdvanceDelivery } from './contract.js';
import { failUnadvanceableRun } from './fail-unadvanceable.repository.js';

export interface RunFailureStore {
  /** For a run that can never move: ends it with this reason. */
  failUnadvanceable(
    input: Readonly<{
      workspaceId: string;
      runId: string;
      safeErrorCode: string;
      delivery?: CoordinatorAdvanceDelivery;
      signal: AbortSignal;
    }>,
  ): Promise<'failed' | 'outcome_unknown' | 'not_active'>;
  close(): Promise<void>;
}

export function createRunFailureStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): RunFailureStore {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    failUnadvanceable: (
      input: Parameters<RunFailureStore['failUnadvanceable']>[0],
    ) => failUnadvanceableRun(lease.pool, input),
    close: () => lease.close(),
  });
}
