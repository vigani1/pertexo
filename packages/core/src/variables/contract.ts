import type {
  WorkspaceVariablesCommandResponse,
  WorkspaceVariablesRequest,
  WorkspaceVariablesResponse,
  WorkspaceVariableUsageCursor,
  WorkspaceVariableUsageResponse,
} from '@pertexo/contracts';

export type VariableScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export type ReplaceWorkspaceVariablesInput = VariableScope &
  WorkspaceVariablesRequest &
  Readonly<{
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
  }>;
export type VariableUsageInput = VariableScope &
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

export interface WorkspaceVariablesStore {
  read(input: VariableScope): Promise<WorkspaceVariablesResponse>;
  replace(
    input: ReplaceWorkspaceVariablesInput,
  ): Promise<WorkspaceVariablesCommandResponse>;
  usage(input: VariableUsageInput): Promise<VariableUsagePage>;
  close(): Promise<void>;
}
export class WorkspaceVariablesConflictError extends Error {
  override readonly name = 'WorkspaceVariablesConflictError';
}
export class WorkspaceVariableUsageChangedError extends Error {
  override readonly name = 'WorkspaceVariableUsageChangedError';
}
