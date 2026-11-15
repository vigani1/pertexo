import { WORKFLOW_INPUT_CASE_LIMITS } from '@pertexo/workflow-model';

export type CaseQuota = Readonly<{
  workflowCount: number;
  workspaceCount: number;
  retainedBytes: number;
}>;

/** Which input-case limit a write of `bytes` would pass; a new case also counts toward both case caps. */
export function caseQuotaRefusal(
  quota: CaseQuota,
  bytes: number,
  { create }: Readonly<{ create: boolean }>,
): 'workflow_count' | 'workspace_count' | 'retained_bytes' | undefined {
  if (create && quota.workflowCount >= WORKFLOW_INPUT_CASE_LIMITS.perWorkflow)
    return 'workflow_count';
  if (create && quota.workspaceCount >= WORKFLOW_INPUT_CASE_LIMITS.perWorkspace)
    return 'workspace_count';
  if (quota.retainedBytes + bytes > WORKFLOW_INPUT_CASE_LIMITS.retainedBytes)
    return 'retained_bytes';
  return undefined;
}
