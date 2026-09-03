import { createDatabasePool } from '../platform/postgres-telemetry.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { withWorkspaceTransaction } from '../tenant-access/workspace.js';

const uuidSchema = z.uuid();
const integrationKeySchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const providerKeySchema = integrationKeySchema.max(64);
const operationKeySchema = integrationKeySchema.max(128);
const limitSchema = z.number().int().positive().max(1_000).default(100);

export type WorkflowIntegrationImpactRecord = Readonly<{
  workflowVersionId: string;
  providerKey: string;
  operationKey: string;
  connectionId: string;
}>;

export type WorkflowIntegrationImpactPage = Readonly<{
  items: readonly WorkflowIntegrationImpactRecord[];
  nextCursor?: WorkflowIntegrationImpactRecord;
}>;

type ImpactRow = Readonly<{
  workflow_version_id: string;
  provider_key: string;
  operation_key: string;
  connection_id: string;
}>;

function mapImpact(row: ImpactRow): WorkflowIntegrationImpactRecord {
  return Object.freeze({
    workflowVersionId: uuidSchema.parse(row.workflow_version_id),
    providerKey: providerKeySchema.parse(row.provider_key),
    operationKey: operationKeySchema.parse(row.operation_key),
    connectionId: uuidSchema.parse(row.connection_id),
  });
}

function page(
  rows: readonly ImpactRow[],
  limit: number,
): WorkflowIntegrationImpactPage {
  const hasMore = rows.length > limit;
  const items = Object.freeze(rows.slice(0, limit).map(mapImpact));
  const last = items.at(-1);
  return Object.freeze({
    items,
    ...(hasMore && last !== undefined ? { nextCursor: last } : {}),
  });
}

export type FindProviderOperationImpactInput = Readonly<{
  workspaceId: string;
  providerKey: string;
  operationKey: string;
  limit?: number;
  after?: Readonly<{ workflowVersionId: string; connectionId: string }>;
}>;

export type FindConnectionImpactInput = Readonly<{
  workspaceId: string;
  connectionId: string;
  limit?: number;
  after?: Readonly<{
    workflowVersionId: string;
    providerKey: string;
    operationKey: string;
  }>;
}>;

export type WorkflowIntegrationUsageDatabase = Readonly<{
  findProviderOperationImpact(
    input: FindProviderOperationImpactInput,
  ): Promise<WorkflowIntegrationImpactPage>;
  findConnectionImpact(
    input: FindConnectionImpactInput,
  ): Promise<WorkflowIntegrationImpactPage>;
  close(): Promise<void>;
}>;

export function createWorkflowIntegrationUsageDatabase(
  config: DatabaseConfig,
): WorkflowIntegrationUsageDatabase {
  const pool = createDatabasePool(config);
  return Object.freeze({
    findProviderOperationImpact: async (input) => {
      const providerKey = providerKeySchema.parse(input.providerKey);
      const operationKey = operationKeySchema.parse(input.operationKey);
      const limit = limitSchema.parse(input.limit);
      const after =
        input.after === undefined
          ? undefined
          : {
              workflowVersionId: uuidSchema.parse(
                input.after.workflowVersionId,
              ),
              connectionId: uuidSchema.parse(input.after.connectionId),
            };
      return withWorkspaceTransaction(
        pool,
        input.workspaceId,
        async ({ db }) => {
          const result = await db.execute<ImpactRow>(sql`
          select workflow_version_id, provider_key, operation_key, connection_id
          from app.workflow_integration_usage
          where provider_key = ${providerKey}
            and operation_key = ${operationKey}
            ${
              after === undefined
                ? sql``
                : sql`and (workflow_version_id, connection_id) >
                    (${after.workflowVersionId}::uuid, ${after.connectionId}::uuid)`
            }
          order by workflow_version_id, connection_id
          limit ${limit + 1}
        `);
          return page(result.rows, limit);
        },
      );
    },
    findConnectionImpact: async (input) => {
      const connectionId = uuidSchema.parse(input.connectionId);
      const limit = limitSchema.parse(input.limit);
      const after =
        input.after === undefined
          ? undefined
          : {
              workflowVersionId: uuidSchema.parse(
                input.after.workflowVersionId,
              ),
              providerKey: providerKeySchema.parse(input.after.providerKey),
              operationKey: operationKeySchema.parse(input.after.operationKey),
            };
      return withWorkspaceTransaction(
        pool,
        input.workspaceId,
        async ({ db }) => {
          const result = await db.execute<ImpactRow>(sql`
          select workflow_version_id, provider_key, operation_key, connection_id
          from app.workflow_integration_usage
          where connection_id = ${connectionId}
            ${
              after === undefined
                ? sql``
                : sql`and (workflow_version_id, provider_key, operation_key) >
                    (${after.workflowVersionId}::uuid, ${after.providerKey}, ${after.operationKey})`
            }
          order by workflow_version_id, provider_key, operation_key
          limit ${limit + 1}
        `);
          return page(result.rows, limit);
        },
      );
    },
    close: () => pool.end(),
  });
}
