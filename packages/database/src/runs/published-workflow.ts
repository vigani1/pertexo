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

const baseRowShape = {
  checksum: z.string(),
  executable_json: z.unknown(),
  executable_schema_version: z.unknown(),
  id: z.uuid(),
  schema_version: z.number().int().positive(),
  version_number: z.number().int().positive(),
  workflow_id: z.uuid(),
  workspace_id: z.uuid(),
};

const retainedV1RowSchema = z
  .object({
    ...baseRowShape,
    checksum: z.string().regex(/^wf:v1:sha256:[0-9a-f]{64}$/u),
    executable_json: z.null(),
    executable_schema_version: z.null(),
  })
  .strict();

const executableV2RowSchema = z
  .object({
    ...baseRowShape,
    checksum: z.string().regex(/^wf:v2:sha256:[0-9a-f]{64}$/u),
    executable_json: z.custom<Record<string, unknown>>(
      (value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value),
    ),
    executable_schema_version: z.literal(2),
  })
  .strict();

export type PublishedWorkflowVersionIdentity = Readonly<{
  checksum: string;
  id: string;
  schemaVersion: number;
  versionNumber: number;
  workflowId: string;
  workspaceId: string;
}>;

export type PublishedWorkflowV2Projection = PublishedWorkflowVersionIdentity &
  Readonly<{
    executableJson: unknown;
    executableSchemaVersion: 2;
  }>;

export type PublishedWorkflowReadResult =
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{
      kind: 'non_executable';
      workflowVersion: PublishedWorkflowVersionIdentity;
    }>
  | Readonly<{
      kind: 'v2_projection';
      workflowVersion: PublishedWorkflowV2Projection;
    }>;

export type ReadPublishedWorkflowForExecutionInput = Readonly<{
  signal?: AbortSignal;
  workflowVersionId: string;
  workspaceId: string;
}>;

export interface PublishedWorkflowReader {
  readForExecution(
    input: ReadPublishedWorkflowForExecutionInput,
  ): Promise<PublishedWorkflowReadResult>;
  close(): Promise<void>;
}

export class PublishedWorkflowVersionCorruptError extends Error {
  public override readonly name = 'PublishedWorkflowVersionCorruptError';

  public constructor() {
    super('Published workflow version violates its persistence invariant');
  }
}

function identityFromRow(
  row: z.output<typeof retainedV1RowSchema>,
): PublishedWorkflowVersionIdentity {
  return Object.freeze({
    checksum: row.checksum,
    id: row.id,
    schemaVersion: row.schema_version,
    versionNumber: row.version_number,
    workflowId: row.workflow_id,
    workspaceId: row.workspace_id,
  });
}

export function classifyPublishedWorkflowVersionRow(
  row: unknown,
): PublishedWorkflowReadResult {
  if (row === undefined) return Object.freeze({ kind: 'not_found' });

  const retained = retainedV1RowSchema.safeParse(row);
  if (retained.success) {
    return Object.freeze({
      kind: 'non_executable',
      workflowVersion: identityFromRow(retained.data),
    });
  }

  const executable = executableV2RowSchema.safeParse(row);
  if (!executable.success) throw new PublishedWorkflowVersionCorruptError();
  return Object.freeze({
    kind: 'v2_projection',
    workflowVersion: Object.freeze({
      checksum: executable.data.checksum,
      executableJson: executable.data.executable_json,
      executableSchemaVersion: executable.data.executable_schema_version,
      id: executable.data.id,
      schemaVersion: executable.data.schema_version,
      versionNumber: executable.data.version_number,
      workflowId: executable.data.workflow_id,
      workspaceId: executable.data.workspace_id,
    }),
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
    ): Promise<PublishedWorkflowReadResult> => {
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
                executable_schema_version,
                executable_json
              from app.workflow_versions
              where workspace_id = ${transaction.workspaceId}
                and id = ${parsedInput.workflowVersionId}
              limit 1
            `,
          );
          return classifyPublishedWorkflowVersionRow(result.rows[0]);
        },
        transactionOptions,
      );
    },
    close: () => lease.close(),
  });
}
