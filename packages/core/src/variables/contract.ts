import type {
  WorkspaceVariablesRequest,
  WorkspaceVariableUsageCursor,
  WorkspaceVariableUsageResponse,
} from '@pertexo/contracts';

import type { WorkspaceActor } from '../shared/workspace-access.js';

export type ReplaceWorkspaceVariablesInput = WorkspaceActor &
  WorkspaceVariablesRequest &
  Readonly<{
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
  }>;
export type VariableUsageInput = WorkspaceActor &
  Readonly<{
    name: string;
    limit: number;
    after?: WorkspaceVariableUsageCursor;
  }>;
export type VariableUsagePage = Omit<
  WorkspaceVariableUsageResponse,
  'nextCursor'
> &
  Readonly<{ next: WorkspaceVariableUsageCursor | null }>;
/** What the page found, before counting how far through the workflows it got. */
export type VariableUsageScan = Omit<
  VariableUsagePage,
  'checkedWorkflows' | 'totalWorkflows'
>;

export class WorkspaceVariablesConflictError extends Error {
  override readonly name = 'WorkspaceVariablesConflictError';
}
export class WorkspaceVariableUsageChangedError extends Error {
  override readonly name = 'WorkspaceVariableUsageChangedError';
}
