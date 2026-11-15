import type { PoolClient } from 'pg';
import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';
import type {
  Scope,
  WorkflowInputCaseMetadata,
} from './workflow-input-case.types.js';
import {
  WorkflowInputCaseLimitError,
  WorkflowInputCaseRevisionConflictError,
} from './workflow-input-case.errors.js';
import {
  lockCase,
  readCaseQuota,
  shareCaseWorkflow,
} from './metadata.repository.js';
import { caseQuotaRefusal } from './case-quota.js';

/** The workflow must be visible, and active for a write. */
export async function requireCaseWorkflow(
  client: PoolClient,
  input: Scope,
  { write }: Readonly<{ write: boolean }>,
): Promise<void> {
  const row = await shareCaseWorkflow(client, input);
  if (row === undefined || (write && row.lifecycleStatus !== 'active'))
    throw new WorkflowNotFoundError('Workflow is not visible');
}

export async function requireCaseQuota(
  client: PoolClient,
  input: Scope,
  bytes: number,
  options: Readonly<{ create: boolean }>,
): Promise<void> {
  const quota = await readCaseQuota(client, input);
  if (!quota) throw new Error('Case quota authority unavailable');
  const refusal = caseQuotaRefusal(quota, bytes, options);
  if (refusal !== undefined) throw new WorkflowInputCaseLimitError(refusal);
}

/** The case at the revision the caller saw, locked for its change. */
export async function requireLockedCase(
  client: PoolClient,
  input: Scope & { caseId: string; expectedRevision: number },
): Promise<WorkflowInputCaseMetadata> {
  const item = await lockCase(client, input);
  if (!item) throw new WorkflowNotFoundError('Run-input case is not visible');
  if (item.revision !== input.expectedRevision)
    throw new WorkflowInputCaseRevisionConflictError(item.revision);
  return item;
}
