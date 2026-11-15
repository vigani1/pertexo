import type {
  AuditMetadata,
  WorkspaceTransaction,
} from '@pertexo/database/primitives';
import { acceptWorkflowRun } from './acceptance/accept.js';
import type { AcceptWorkflowRunInput } from './acceptance/run-acceptance.types.js';
import { requireWorkflowRun } from '../workflow-run.errors.js';
import {
  insertWorkflowRunAudit,
  readWorkflowRunRecord,
  type WorkflowRunRecord,
} from './workflow-run-records.repository.js';

export async function acceptWorkflowRunWithAudit(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    acceptance: AcceptWorkflowRunInput;
    actorId: string;
    auditAction: string;
    auditMetadata: AuditMetadata;
    requestId?: string;
    traceId?: string;
  }>,
): Promise<Readonly<{ run: WorkflowRunRecord; replayed: boolean }>> {
  const accepted = await acceptWorkflowRun(transaction, {
    ...input.acceptance,
    startedBy: input.actorId,
  });
  const run = requireWorkflowRun(
    await readWorkflowRunRecord(transaction, accepted.runId),
  );
  if (!accepted.duplicate) {
    await insertWorkflowRunAudit(transaction, {
      action: input.auditAction,
      actorId: input.actorId,
      runId: run.id,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      metadata: input.auditMetadata,
    });
  }
  return Object.freeze({ run, replayed: accepted.duplicate });
}
