import { and, eq, sql } from 'drizzle-orm';
import type {
  DatabaseRuntime,
  DatabaseConfig,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import { workflowIntegrationUsage as usage } from '@pertexo/database/schema';
import type {
  FindConnectionImpactInput,
  FindProviderOperationImpactInput,
  WorkflowIntegrationImpactPage,
  WorkflowIntegrationImpactRecord,
} from './contract.js';

import { withWorkspaceTransaction } from '@pertexo/database/primitives';

const DEFAULT_IMPACT_PAGE_SIZE = 100;

export type WorkflowIntegrationUsageStore = ReturnType<
  typeof createWorkflowIntegrationUsageStore
>;

function page(
  rows: readonly WorkflowIntegrationImpactRecord[],
  limit: number,
): WorkflowIntegrationImpactPage {
  const hasMore = rows.length > limit;
  const items = Object.freeze(
    rows.slice(0, limit).map((row) => Object.freeze(row)),
  );
  const last = items.at(-1);
  return Object.freeze({
    items,
    ...(hasMore && last !== undefined ? { nextCursor: last } : {}),
  });
}

export function createWorkflowIntegrationUsageStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    findProviderOperationImpact: async (
      input: FindProviderOperationImpactInput,
    ) => {
      const providerKey = input.providerKey;
      const operationKey = input.operationKey;
      const limit = input.limit ?? DEFAULT_IMPACT_PAGE_SIZE;
      const after =
        input.after === undefined
          ? undefined
          : {
              workflowVersionId: input.after.workflowVersionId,
              connectionId: input.after.connectionId,
            };
      return withWorkspaceTransaction(
        pool,
        input.workspaceId,
        async ({ db }) => {
          const result = await db
            .select({
              workflowVersionId: usage.workflowVersionId,
              providerKey: usage.providerKey,
              operationKey: usage.operationKey,
              connectionId: usage.connectionId,
            })
            .from(usage)
            .where(
              and(
                eq(usage.providerKey, providerKey),
                eq(usage.operationKey, operationKey),
                after === undefined
                  ? undefined
                  : sql`(${usage.workflowVersionId},${usage.connectionId})>(${after.workflowVersionId}::uuid,${after.connectionId}::uuid)`,
              ),
            )
            .orderBy(usage.workflowVersionId, usage.connectionId)
            .limit(limit + 1);
          return page(result, limit);
        },
      );
    },
    findConnectionImpact: async (input: FindConnectionImpactInput) => {
      const connectionId = input.connectionId;
      const limit = input.limit ?? DEFAULT_IMPACT_PAGE_SIZE;
      const after =
        input.after === undefined
          ? undefined
          : {
              workflowVersionId: input.after.workflowVersionId,
              providerKey: input.after.providerKey,
              operationKey: input.after.operationKey,
            };
      return withWorkspaceTransaction(
        pool,
        input.workspaceId,
        async ({ db }) => {
          const result = await db
            .select({
              workflowVersionId: usage.workflowVersionId,
              providerKey: usage.providerKey,
              operationKey: usage.operationKey,
              connectionId: usage.connectionId,
            })
            .from(usage)
            .where(
              and(
                eq(usage.connectionId, connectionId),
                after === undefined
                  ? undefined
                  : sql`(${usage.workflowVersionId},${usage.providerKey},${usage.operationKey})>(${after.workflowVersionId}::uuid,${after.providerKey},${after.operationKey})`,
              ),
            )
            .orderBy(
              usage.workflowVersionId,
              usage.providerKey,
              usage.operationKey,
            )
            .limit(limit + 1);
          return page(result, limit);
        },
      );
    },
    close: () => lease.close(),
  });
}
