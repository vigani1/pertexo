import { decodeStoredReceipt } from '../../shared/receipts.js';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { WorkflowCommentCommandResult } from '@pertexo/contracts';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';
import type { EnterCollaboration } from './authority.repository.js';
import type { CollaborationCommand } from './workflow-collaboration.types.js';

/** The command output retained for exact retries. */
const commentReceipt = z
  .object({
    threadId: z.uuid(),
    commentId: z.uuid().nullable(),
    revision: z.number().int().positive(),
    replayed: z.boolean(),
    deleted: z.boolean(),
    threadDeleted: z.boolean(),
  })
  .strict();
export function runCommentCommand(
  enter: EnterCollaboration,
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
  return enter(input, {}, async (client) => {
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
        ...decodeStoredReceipt(commentReceipt, stored),
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
  });
}
