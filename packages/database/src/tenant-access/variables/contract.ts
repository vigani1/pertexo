import type {
  WorkspaceVariablesRequest,
  WorkspaceVariablesResponse,
  WorkspaceVariablesCommandResponse,
  WorkspaceVariableUsageCursor,
  WorkspaceVariableUsageResponse,
} from '@pertexo/contracts';
export type VariableScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
  requestId?: string;
  traceId?: string;
}>;
export interface WorkspaceVariablesStore {
  read(input: VariableScope): Promise<WorkspaceVariablesResponse>;
  replace(
    input: VariableScope &
      WorkspaceVariablesRequest &
      Readonly<{ idempotencyKey: string }>,
  ): Promise<WorkspaceVariablesCommandResponse>;
  usage(
    input: VariableScope &
      Readonly<{
        name: string;
        limit: number;
        after?: WorkspaceVariableUsageCursor;
      }>,
  ): Promise<
    Omit<WorkspaceVariableUsageResponse, 'nextCursor'> &
      Readonly<{ next: WorkspaceVariableUsageCursor | null }>
  >;
  close(): Promise<void>;
}
export class WorkspaceVariablesConflictError extends Error {
  override readonly name = 'WorkspaceVariablesConflictError';
}
export class WorkspaceVariableUsageChangedError extends Error {
  override readonly name = 'WorkspaceVariableUsageChangedError';
}
