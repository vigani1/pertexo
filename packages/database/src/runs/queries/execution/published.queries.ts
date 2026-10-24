import type { PublishedWorkflow } from './contract.js';
import type { ReadPublishedWorkflowForExecutionInput } from './contract.js';
import type { PublishedWorkflowReader } from './contract.js';
import { workflowVersions } from '../../../schema/authoring/workflows.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { acquireDatabasePool } from '../../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../../platform/pool/runtime.js';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseConfig } from '../../../config.js';
import { withWorkspaceTransaction } from '../../../tenant-access/transactions.js';

const readInputSchema = z
  .object({
    signal: z.instanceof(AbortSignal).optional(),
    workflowVersionId: z.uuid(),
    workspaceId: z.uuid(),
  })
  .strict();

export function createPublishedWorkflowReader(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): PublishedWorkflowReader {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;

  return Object.freeze({
    readForExecution: async (
      input: ReadPublishedWorkflowForExecutionInput,
    ): Promise<PublishedWorkflow | null> => {
      const parsedInput = readInputSchema.parse(input);
      const transactionOptions =
        parsedInput.signal === undefined
          ? undefined
          : { signal: parsedInput.signal };
      return withWorkspaceTransaction(
        pool,
        parsedInput.workspaceId,
        async (transaction) => {
          return findPublishedWorkflow(transaction.db, {
            workspaceId: transaction.workspaceId,
            id: parsedInput.workflowVersionId,
          });
        },
        transactionOptions,
      );
    },
    close: () => lease.close(),
  });
}

export async function findPublishedWorkflow(
  db: Pick<NodePgDatabase, 'select'>,
  {
    workspaceId,
    id,
    workflowId,
  }: Readonly<{ workspaceId: string; id: string | null; workflowId?: string }>,
): Promise<PublishedWorkflow | null> {
  const [row] = await db
    .select({
      checksum: workflowVersions.checksum,
      executableJson: workflowVersions.executableJson,
      id: workflowVersions.id,
      versionNumber: workflowVersions.versionNumber,
      workflowId: workflowVersions.workflowId,
      workspaceId: workflowVersions.workspaceId,
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.id, sql`${id}::uuid`),
        workflowId === undefined
          ? undefined
          : eq(workflowVersions.workflowId, workflowId),
      ),
    )
    .limit(1);
  return row === undefined ? null : Object.freeze(row);
}
