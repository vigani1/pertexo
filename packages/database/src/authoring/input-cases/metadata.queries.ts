import type { PoolClient } from 'pg';
import { z } from 'zod';

import { WorkflowNotFoundError } from '../workflows/errors.js';
import {
  type WorkflowInputCaseMetadata,
  type Scope,
  WorkflowInputCaseRevisionConflictError,
  WorkflowInputCaseLimitError,
  revisionSchema,
} from './contract.js';

export const metadataColumns =
  'id,workspace_id,workflow_id,workflow_version_id,version_checksum,name,revision,created_at,updated_at';

export function metadata(
  row: Record<string, unknown>,
): WorkflowInputCaseMetadata {
  return Object.freeze({
    id: z.uuid().parse(row.id),
    workspaceId: z.uuid().parse(row.workspace_id),
    workflowId: z.uuid().parse(row.workflow_id),
    workflowVersionId: z.uuid().parse(row.workflow_version_id),
    versionChecksum: z.string().parse(row.version_checksum),
    name: z.string().parse(row.name),
    revision: revisionSchema.parse(row.revision),
    createdAt: z.coerce.date().parse(row.created_at),
    updatedAt: z.coerce.date().parse(row.updated_at),
  });
}

export async function workflow(
  client: PoolClient,
  input: Scope,
  { write }: Readonly<{ write: boolean }>,
): Promise<void> {
  const row = await client.query<{ lifecycle_status: string }>(
    'select lifecycle_status from app.workflows where workspace_id=$1 and id=$2 for share',
    [input.workspaceId, input.workflowId],
  );
  const workflowUnavailable =
    row.rowCount !== 1 || (write && row.rows[0]?.lifecycle_status !== 'active');
  if (workflowUnavailable)
    throw new WorkflowNotFoundError('Workflow is not visible');
}

export async function quota(
  client: PoolClient,
  input: Scope,
  bytes: number,
  { create }: Readonly<{ create: boolean }>,
): Promise<void> {
  const result = await client.query<{
    workflow_count: string;
    workspace_count: string;
    retained_bytes: string;
  }>(
    `select (select count(*) from app.workflow_input_cases where workspace_id=$1 and workflow_id=$2 and deleted_at is null) workflow_count,(select count(*) from app.workflow_input_cases where workspace_id=$1 and deleted_at is null) workspace_count,(select coalesce(sum(canonical_bytes),0) from app.workflow_input_case_payloads where workspace_id=$1) retained_bytes`,
    [input.workspaceId, input.workflowId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Case quota authority unavailable');
  if (create && Number(row.workflow_count) >= 50)
    throw new WorkflowInputCaseLimitError('workflow_count');
  if (create && Number(row.workspace_count) >= 200)
    throw new WorkflowInputCaseLimitError('workspace_count');
  if (Number(row.retained_bytes) + bytes > 4_194_304)
    throw new WorkflowInputCaseLimitError('retained_bytes');
}

export async function lockedCase(
  client: PoolClient,
  input: Scope & { caseId: string; expectedRevision: number },
): Promise<WorkflowInputCaseMetadata> {
  z.uuid().parse(input.caseId);
  revisionSchema.parse(input.expectedRevision);
  const result = await client.query<Record<string, unknown>>(
    `select ${metadataColumns} from app.workflow_input_cases where workspace_id=$1 and workflow_id=$2 and id=$3 and deleted_at is null for update`,
    [input.workspaceId, input.workflowId, input.caseId],
  );
  if (!result.rows[0])
    throw new WorkflowNotFoundError('Run-input case is not visible');
  const item = metadata(result.rows[0]);
  if (item.revision !== input.expectedRevision)
    throw new WorkflowInputCaseRevisionConflictError(item.revision);
  return item;
}

/** Cases and a suite's frozen manifest share one quota/mutation fence. */
export async function lockInputCaseQuota(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    `workflow-input-case-quota:${workspaceId}`,
  ]);
}
