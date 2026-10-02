import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/database-runtime.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';
import { workflowFolderDatabaseFailure } from './workflow-folders.js';
import { WorkflowOrganizationValidationError } from './workflow-organization-errors.js';

type Scope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export type WorkflowOrganizationBatchItem = Readonly<{
  workflowId: string;
  expectedOrganizationRevision: number;
}>;
type Selection = Readonly<{ items: readonly WorkflowOrganizationBatchItem[] }>;
export type WorkflowOrganizationBatchRequest = Selection &
  (
    | Readonly<{ operation: 'move'; folderId: string | null }>
    | Readonly<{ operation: 'replace_tags'; tagIds: readonly string[] }>
    | Readonly<{ operation: 'tag_cleanup'; tagId: string }>
  );
export type WorkflowOrganizationBatchInput = Scope &
  Readonly<{
    idempotencyKey: string;
    request: WorkflowOrganizationBatchRequest;
  }>;
export type WorkflowOrganizationBatchItemResult = Readonly<{
  workflowId: string;
  organizationRevision: number;
  replayed: boolean;
  folderId?: string | null;
}>;
export interface WorkflowOrganizationBatchDatabase {
  admitBatch(
    input: WorkflowOrganizationBatchInput,
  ): Promise<Readonly<{ admitted: true }>>;
  executeBatchItem(
    input: WorkflowOrganizationBatchInput & Readonly<{ workflowId: string }>,
  ): Promise<WorkflowOrganizationBatchItemResult>;
  close(): Promise<void>;
}
const uuid = z.uuid().overwrite((value) => value.toLowerCase());
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const item = z
  .object({ workflowId: uuid, expectedOrganizationRevision: revision })
  .strict();
const items = z
  .array(item)
  .min(1)
  .max(50)
  .refine(
    (value) =>
      new Set(value.map((entry) => entry.workflowId)).size === value.length,
  );
const tags = z
  .array(uuid)
  .max(16)
  .refine((value) => new Set(value).size === value.length)
  .overwrite((value) => [...value].sort());
const request = z.discriminatedUnion('operation', [
  z
    .object({ operation: z.literal('move'), folderId: uuid.nullable(), items })
    .strict(),
  z
    .object({ operation: z.literal('replace_tags'), tagIds: tags, items })
    .strict(),
  z
    .object({ operation: z.literal('tag_cleanup'), tagId: uuid, items })
    .strict(),
]);
const scopeSchema = z.object({
  workspaceId: uuid,
  actorId: uuid,
  signal: z.instanceof(AbortSignal).optional(),
});
const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$(?![\s\S])/u)
  .refine((value) => !value.includes(','));
const admitted = z.object({ admitted: z.literal(true) }).strict();
const baseResult = z
  .object({
    workflowId: uuid,
    organizationRevision: revision,
    replayed: z.boolean(),
  })
  .strict();
const moveResult = baseResult.extend({ folderId: uuid.nullable() }).strict();
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Admission and each item are deliberately separate tenant transactions.
 * This module never auto-admits, retries, rotates keys or executes other items. */
export function createWorkflowOrganizationBatchDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowOrganizationBatchDatabase {
  const lease = acquireDatabasePool(config, options.runtime);
  async function transact<T>(
    input: Scope,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const { signal, ...ids } = scopeSchema.parse(input);
    const scope = signal === undefined ? ids : { ...ids, signal };
    try {
      return await withTenantScopedClient(
        lease.pool,
        scope,
        work,
        signal === undefined ? {} : { signal },
      );
    } catch (error: unknown) {
      return workflowFolderDatabaseFailure(error);
    }
  }
  return Object.freeze({
    async admitBatch(input: WorkflowOrganizationBatchInput) {
      const body = request.parse(input.request),
        parentKeyHash = hash(key.parse(input.idempotencyKey));
      return transact(input, async (client) => {
        const result = await client.query<{ result: unknown }>(
          'select app.admit_workflow_organization_batch($1,$2::jsonb) result',
          [parentKeyHash, JSON.stringify(body)],
        );
        return Object.freeze(admitted.parse(result.rows[0]?.result));
      });
    },
    async executeBatchItem(
      input: WorkflowOrganizationBatchInput & Readonly<{ workflowId: string }>,
    ) {
      const body = request.parse(input.request),
        workflowId = uuid.parse(input.workflowId);
      if (!body.items.some((entry) => entry.workflowId === workflowId))
        throw new WorkflowOrganizationValidationError();
      const parentKeyHash = hash(key.parse(input.idempotencyKey));
      const itemKeyHash = hash(
        JSON.stringify({
          v: 1,
          p: 'organization.batch.item',
          k: parentKeyHash,
          id: workflowId,
        }),
      );
      return transact(input, async (client) => {
        const result = await client.query<{ result: unknown }>(
          'select app.execute_workflow_organization_batch_item($1,$2::jsonb,$3,$4) result',
          [parentKeyHash, JSON.stringify(body), workflowId, itemKeyHash],
        );
        return Object.freeze(
          (body.operation === 'move' ? moveResult : baseResult).parse(
            result.rows[0]?.result,
          ),
        );
      });
    },
    close: lease.close,
  });
}
