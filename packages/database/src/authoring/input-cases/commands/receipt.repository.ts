import { appendAuditFact } from '../../../governance/audit/events.repository.js';
import type { PoolClient } from 'pg';

import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';

import type {
  WorkflowInputCaseResult,
  Command,
  CaseTransaction,
} from '../contract.js';
import { resultSchema } from '../input.js';
import { workflow, lockInputCaseQuota } from '../metadata.queries.js';

export async function mutate(
  transact: CaseTransaction,
  input: Command,
  {
    kind,
    caseId,
    intent,
    work,
  }: Readonly<{
    kind: 'create' | 'update' | 'delete';
    caseId: string;
    intent: Record<string, unknown>;
    work: (client: PoolClient) => Promise<{ caseId: string; revision: number }>;
  }>,
): Promise<WorkflowInputCaseResult> {
  const command = {
    workspaceId: input.workspaceId,
    operation: `workflow.inputcase.${kind}`,
    scope: `${input.actorId}:${input.workflowId}`,
    idempotencyKey: input.idempotencyKey,
  };
  return transact(input, {
    write: true,
    work: async (client) => {
      const stored = await claimCommand(client, {
        ...command,
        request: intent,
        resourceId: caseId,
      });
      if (stored !== null)
        return Object.freeze({ ...resultSchema.parse(stored), replayed: true });
      await workflow(client, input, { write: true });
      await lockInputCaseQuota(client, input.workspaceId);
      const result = await work(client);
      await appendAuditFact(client, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: `workflow.input_case.${kind}`,
        targetType: 'workflow_input_case',
        targetId: result.caseId,
        requestId: input.requestId ?? null,
        traceId: input.traceId ?? null,
        metadata: { workflowId: input.workflowId, revision: result.revision },
      });
      await completeCommand(client, command, result);
      return Object.freeze({ ...result, replayed: false });
    },
  });
}
