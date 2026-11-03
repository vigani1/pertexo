import type { workflowInputCases } from '@pertexo/database/schema';
import type { PoolClient } from 'pg';
import type { WorkflowTestExpectations } from '@pertexo/workflow-model';

export type WorkflowInputCaseMetadata = Readonly<
  Pick<
    typeof workflowInputCases.$inferSelect,
    | 'id'
    | 'workspaceId'
    | 'workflowId'
    | 'workflowVersionId'
    | 'versionChecksum'
    | 'name'
    | 'revision'
    | 'createdAt'
    | 'updatedAt'
  >
>;

export type WorkflowInputCaseResult = Readonly<{
  caseId: string;
  revision: number;
  replayed: boolean;
}>;

export type Scope = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  signal?: AbortSignal;
}>;

export type Command = Scope &
  Readonly<{ idempotencyKey: string; requestId?: string; traceId?: string }>;

export type ListInputCasesInput = Scope & {
  limit: number;
  cursor?: { createdAt: Date; id: string };
};
export interface InputCasePage {
  items: readonly WorkflowInputCaseMetadata[];
  nextCursor?: { createdAt: Date; id: string };
}
export type GetInputCaseInput = Scope & { caseId: string };
export interface InputCaseDetail {
  case: WorkflowInputCaseMetadata & {
    input: unknown;
    expectations?: WorkflowTestExpectations;
  };
}
export type CreateInputCaseInput = Command & {
  workflowVersionId: string;
  name: string;
  input: unknown;
  expectations?: WorkflowTestExpectations;
};
export type UpdateInputCaseInput = Command & {
  caseId: string;
  expectedRevision: number;
  name: string;
  input: unknown;
  expectations?: WorkflowTestExpectations;
};
export type DeleteInputCaseInput = Command & {
  caseId: string;
  expectedRevision: number;
};

export type CaseTransaction = <T>(
  input: Scope,
  options: Readonly<{
    write: boolean;
    work: (client: PoolClient) => Promise<T>;
  }>,
) => Promise<T>;
