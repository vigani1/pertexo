import type { PoolClient } from 'pg';
import type { WorkflowTestExpectations } from '@pertexo/workflow-model';

export type WorkflowInputCaseMetadata = Readonly<{
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string;
  versionChecksum: string;
  name: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}>;

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

export interface WorkflowInputCaseDatabase {
  listCases(
    input: Scope & { limit: number; cursor?: { createdAt: Date; id: string } },
  ): Promise<{
    items: readonly WorkflowInputCaseMetadata[];
    nextCursor?: { createdAt: Date; id: string };
  }>;
  getCase(input: Scope & { caseId: string }): Promise<{
    case: WorkflowInputCaseMetadata & {
      input: unknown;
      expectations?: WorkflowTestExpectations;
    };
  }>;
  createCase(
    input: Command & {
      workflowVersionId: string;
      name: string;
      input: unknown;
      expectations?: WorkflowTestExpectations;
    },
  ): Promise<WorkflowInputCaseResult>;
  updateCase(
    input: Command & {
      caseId: string;
      expectedRevision: number;
      name: string;
      input: unknown;
      expectations?: WorkflowTestExpectations;
    },
  ): Promise<WorkflowInputCaseResult>;
  deleteCase(
    input: Command & { caseId: string; expectedRevision: number },
  ): Promise<WorkflowInputCaseResult>;
  close(): Promise<void>;
}

export type CaseTransaction = <T>(
  input: Scope,
  options: Readonly<{
    write: boolean;
    work: (client: PoolClient) => Promise<T>;
  }>,
) => Promise<T>;
