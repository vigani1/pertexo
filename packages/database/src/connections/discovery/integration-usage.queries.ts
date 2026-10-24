import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { and, eq, sql } from 'drizzle-orm';
import { workflowIntegrationUsage as usage } from '../../schema/authoring/integrations.js';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import { withWorkspaceTransaction } from '../../tenant-access/transactions.js';

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
  runtime?: DatabaseRuntime,
): WorkflowIntegrationUsageDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
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
