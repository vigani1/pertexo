import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  inspectJsonValue,
  normalizedJson,
  type WorkflowTestExpectations,
} from '@pertexo/workflow-model';

import { serializeStoredExecutionJsonValue } from '../../platform/stored-execution-value.js';

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

export class WorkflowInputCaseRevisionConflictError extends Error {
  override readonly name = 'WorkflowInputCaseRevisionConflictError';
  constructor(readonly currentRevision: number) {
    super('Run-input case revision changed');
  }
}

export class WorkflowInputCaseLimitError extends Error {
  override readonly name = 'WorkflowInputCaseLimitError';
  constructor(
    readonly kind: 'workflow_count' | 'workspace_count' | 'retained_bytes',
  ) {
    super('Run-input case storage limit reached');
  }
}

export const scopeSchema = z.object({
  workspaceId: z.uuid(),
  actorId: z.uuid(),
  workflowId: z.uuid(),
  signal: z.instanceof(AbortSignal).optional(),
});

export const revisionSchema = z.number().int().positive().max(2_147_483_646);

export const resultSchema = z
  .object({ caseId: z.uuid(), revision: revisionSchema })
  .strict();

export function payload(value: unknown): { text: string; bytes: number } {
  serializeStoredExecutionJsonValue(value);
  const inspection = inspectJsonValue(value);
  const inputExceedsLimits =
    inspection.bytes > 65_536 ||
    inspection.depth > 64 ||
    inspection.members > 10_000;
  if (inputExceedsLimits)
    throw new TypeError('Run-input case JSON exceeds its bounds');
  // The case keeps its fields in the order they were written.
  const text = normalizedJson(value);
  return { text, bytes: inspection.bytes };
}

export type CaseTransaction = <T>(
  input: Scope,
  options: Readonly<{
    write: boolean;
    work: (client: PoolClient) => Promise<T>;
  }>,
) => Promise<T>;
