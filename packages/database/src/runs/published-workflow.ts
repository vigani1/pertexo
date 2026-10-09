import { acquireDatabasePool } from '../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../platform/pool/runtime.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { withWorkspaceTransaction } from '../tenant-access/transactions.js';

const readInputSchema = z
  .object({
    signal: z.instanceof(AbortSignal).optional(),
    workflowVersionId: z.uuid(),
    workspaceId: z.uuid(),
  })
  .strict();

const publishedRowSchema = z
  .object({
    checksum: z.string().regex(/^wf:v2:sha256:[0-9a-f]{64}$/u),
    executable_json: z.custom<Record<string, unknown>>(
      (value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value),
    ),
    id: z.uuid(),
    schema_version: z.number().int().positive(),
    version_number: z.number().int().positive(),
    workflow_id: z.uuid(),
    workspace_id: z.uuid(),
  })
  .strict();

/** A published workflow version with the executable a run follows. */
export type PublishedWorkflow = Readonly<{
  checksum: string;
  executableJson: unknown;
  id: string;
  schemaVersion: number;
  versionNumber: number;
  workflowId: string;
  workspaceId: string;
}>;

export type ReadPublishedWorkflowForExecutionInput = Readonly<{
  signal?: AbortSignal;
  workflowVersionId: string;
  workspaceId: string;
}>;

export interface PublishedWorkflowReader {
  /** The published version, or null when it is not visible. */
  readForExecution(
    input: ReadPublishedWorkflowForExecutionInput,
  ): Promise<PublishedWorkflow | null>;
  close(): Promise<void>;
}

export class PublishedWorkflowVersionCorruptError extends Error {
  public override readonly name = 'PublishedWorkflowVersionCorruptError';

  public constructor() {
    super('Published workflow version violates its persistence invariant');
  }
}

/** Reads a `workflow_versions` row; null when there is none. */
export function parsePublishedWorkflowRow(
  row: unknown,
): PublishedWorkflow | null {
  if (row === undefined) return null;
  const parsed = publishedRowSchema.safeParse(row);
  if (!parsed.success) throw new PublishedWorkflowVersionCorruptError();
  return Object.freeze({
    checksum: parsed.data.checksum,
    executableJson: parsed.data.executable_json,
    id: parsed.data.id,
    schemaVersion: parsed.data.schema_version,
    versionNumber: parsed.data.version_number,
    workflowId: parsed.data.workflow_id,
    workspaceId: parsed.data.workspace_id,
  });
}

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
          const result = await transaction.db.execute(
            sql<Record<string, unknown>>`
              select
                id,
                workspace_id,
                workflow_id,
                version_number,
                schema_version,
                checksum,
                executable_json
              from app.workflow_versions
              where workspace_id = ${transaction.workspaceId}
                and id = ${parsedInput.workflowVersionId}
              limit 1
            `,
          );
          return parsePublishedWorkflowRow(result.rows[0]);
        },
        transactionOptions,
      );
    },
    close: () => lease.close(),
  });
}
