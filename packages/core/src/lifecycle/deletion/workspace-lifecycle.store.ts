import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { requestWorkspaceLifecycleOperation } from './request-workspace-lifecycle.js';
import type { RequestWorkspaceLifecycleOperationInput } from './workspace-lifecycle.types.js';

export function createWorkspaceLifecycleStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    requestWorkspaceLifecycleOperation: (
      input: RequestWorkspaceLifecycleOperationInput,
    ) => requestWorkspaceLifecycleOperation(lease.pool, input),
    close: () => lease.close(),
  });
}

export type WorkspaceLifecycleStore = ReturnType<
  typeof createWorkspaceLifecycleStore
>;
