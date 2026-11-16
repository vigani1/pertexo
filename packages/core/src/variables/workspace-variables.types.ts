import type {
  WorkspaceVariablesRequest,
  WorkspaceVariableUsageCursor,
  WorkspaceVariableUsageResponse,
} from '@pertexo/contracts';

import type { WorkspaceActor } from '../shared/access/workspace-access.js';

export type ReplaceWorkspaceVariablesInput = WorkspaceActor &
  WorkspaceVariablesRequest &
  Readonly<{
    idempotencyKey: string;
    commandCredentialId?: string;
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
/** A bounded page and its continuation, with no global population recount. */
export type VariableUsageScan = VariableUsagePage;
