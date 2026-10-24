import { rethrowQueryFailure } from '../platform/query-errors.js';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaces } from '../schema/foundation.js';
import type { PoolClient } from 'pg';
import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/pool/runtime.js';
import {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from '../tenant-access/transactions.js';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../tenant-access/workspaces/authority.queries.js';
import {
  rolesForCapability,
  type AuthorizationCapability,
} from '@pertexo/workflow-model';
import type { GovernanceStore, GovernanceScope } from './contract.js';
import {
  readAuditBatch,
  decodeAuditCursor,
  encodeAuditCursor,
  projectAuditEvent,
} from './audit/events.queries.js';
import { prepareAuditExport } from './audit/export.queries.js';
import { configureGovernance } from './settings/policy.repository.js';
import { readGovernanceSettings } from './settings/policy.queries.js';
export function createGovernanceStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): GovernanceStore {
  const lease = acquireDatabasePool(config, runtime);
  const read = <T>(
    input: GovernanceScope,
    capability: AuthorizationCapability,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    withTenantScopedReadClient(
      lease.pool,
      input,
      async (client) => {
        await readWorkspaceAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles: rolesForCapability(capability),
          allowedStatuses: ['active', 'suspended', 'pending_deletion'],
        });
        return work(client);
      },
      input.signal === undefined ? {} : { signal: input.signal },
    );
  return {
    close: () => lease.close(),
    list: async (input) => {
      const after = decodeAuditCursor(input.query.after);
      return read(input, 'audit:read', async (client) => {
        const rows = await readAuditBatch(client, input.workspaceId, {
          query: input.query,
          limit: input.query.limit + 1,
          after,
        });
        const items = rows.slice(0, input.query.limit);
        const last = items.at(-1);
        return {
          items: items.map(projectAuditEvent),
          nextCursor:
            rows.length > input.query.limit && last !== undefined
              ? encodeAuditCursor(last)
              : null,
        };
      });
    },
    settings: (input) =>
      read(input, 'audit:read', (client) =>
        readGovernanceSettings(client, input.workspaceId),
      ),
    configure: (input) =>
      withTenantScopedClient(
        lease.pool,
        input,
        async (client) => {
          await drizzle(client)
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, input.workspaceId))
            .for('update')
            .catch(rethrowQueryFailure);
          await lockWorkspaceAuthority(
            client,
            input.workspaceId,
            input.actorId,
            rolesForCapability('governance:manage'),
          );
          return configureGovernance(client, input);
        },
        input.signal === undefined ? {} : { signal: input.signal },
      ),
    exportCsv: async (input) => {
      const prepared = await prepareAuditExport(
        (work) => read(input, 'audit:read', work),
        input.workspaceId,
        input.query,
        input.signal,
      );
      await input.consume(prepared.csv, prepared.metadata);
    },
  };
}
