import type { PoolClient } from 'pg';
import type { WorkflowCommentCommandResult } from '@pertexo/contracts';
import {
  claimCommand,
  completeCommand,
  appendAuditFact,
} from '@pertexo/database/primitives';
import { requireCollaborationAuthority } from './authority.queries.js';
import type { CollaborationCommand, CollaborationContext } from './contract.js';
export function runCommentCommand(
  context: CollaborationContext,
  input: CollaborationCommand,
  {
    action,
    request,
    write,
    status,
  }: Readonly<{
    action: string;
    request: unknown;
    write: (client: PoolClient) => Promise<WorkflowCommentCommandResult>;
    status?: ('open' | 'resolved') | undefined;
  }>,
) {
  return context.transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await requireCollaborationAuthority(client, input);
      const command = {
        workspaceId: input.workspaceId,
        scope: input.actorId + ':' + input.workflowId,
        operation: action,
        idempotencyKey: input.idempotencyKey,
      };
      const stored = await claimCommand<WorkflowCommentCommandResult>(client, {
        ...command,
        resourceId: input.workflowId,
        request,
      });
      if (stored !== null)
        return {
          ...stored,
          replayed: true,
        };
      const result = await write(client);
      await appendAuditFact(client, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action,
        targetType: 'workflow',
        targetId: input.workflowId,
        requestId: input.requestId ?? null,
        traceId: input.traceId ?? null,
        metadata: {
          threadId: result.threadId,
          commentId: result.commentId,
          revision: result.revision,
          deleted: result.deleted,
          threadDeleted: result.threadDeleted,
          ...(status === undefined ? {} : { status }),
        },
      });
      await completeCommand(client, command, result);
      return result;
    },
    input.signal,
  );
}
