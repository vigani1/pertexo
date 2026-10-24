import type { PoolClient } from 'pg';

import {
  claimCommand,
  completeCommand,
} from '../../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';

import {
  type WorkflowInputCaseResult,
  type Command,
  resultSchema,
  type CaseTransaction,
} from '../contract.js';
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
      await client.query(
        "insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata) values($1,$2,$3,$4,'workflow_input_case',$5,$6,$7,$8::jsonb)",
        [
          generatePersistedId(),
          input.workspaceId,
          input.actorId,
          `workflow.input_case.${kind}`,
          result.caseId,
          input.requestId ?? null,
          input.traceId ?? null,
          JSON.stringify({
            workflowId: input.workflowId,
            revision: result.revision,
          }),
        ],
      );
      await completeCommand(client, command, result);
      return Object.freeze({ ...result, replayed: false });
    },
  });
}
