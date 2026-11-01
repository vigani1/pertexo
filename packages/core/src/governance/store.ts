import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  ACTIVE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../shared/workspace-access.js';
import { decodeAuditCursor } from './audit/cursor.js';
import { streamAuditExport } from './audit/export.js';
import { readAuditPage } from './audit/page.js';
import type {
  ConfigureGovernanceInput,
  ExportAuditInput,
  ListAuditInput,
} from './contract.js';
import { configureGovernance } from './settings/configure.js';
import { readGovernanceSettings } from './settings/policy.queries.js';

export type GovernanceStore = ReturnType<typeof createGovernanceStore>;

/** Each action opens its own transaction and decides authority inside it. */
export function createGovernanceStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const read = <T>(
    actor: WorkspaceActor,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    withWorkspaceAccess(
      lease.pool,
      actor,
      {
        mode: 'read',
        capability: 'audit:read',
        statuses: UNPURGED_WORKSPACE_STATUSES,
      },
      work,
    );
  return {
    close: () => lease.close(),
    list: async (input: ListAuditInput) => {
      const after = decodeAuditCursor(input.query.after);
      return read(input, (client) => readAuditPage(client, input, after));
    },
    settings: (actor: WorkspaceActor) =>
      read(actor, (client) =>
        readGovernanceSettings(client, actor.workspaceId),
      ),
    configure: (input: ConfigureGovernanceInput) =>
      withWorkspaceAccess(
        lease.pool,
        input,
        {
          // Saving updates the workspace row itself.
          mode: 'exclusive',
          capability: 'governance:manage',
          statuses: ACTIVE_WORKSPACE_STATUSES,
        },
        (client) => configureGovernance(client, input),
      ),
    exportCsv: async (input: ExportAuditInput) => {
      const prepared = await streamAuditExport(
        (work) => read(input, work),
        input,
      );
      await input.consume(prepared.csv, prepared.metadata);
    },
  };
}
