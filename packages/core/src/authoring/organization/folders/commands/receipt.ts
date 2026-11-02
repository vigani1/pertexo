import type { Role } from '@pertexo/workflow-model';

import type { PoolClient } from 'pg';

import { runOrganizationCommand } from '../../run-command.js';

import type { createOrganizationSession } from '../../session.js';
import type { Command, WorkflowFolderCommandResult } from '../contract.js';
import { folderResult } from '../input.js';
import { type FolderRow, folderRecord } from '../hierarchy.queries.js';

export function folderCommand(
  session: ReturnType<typeof createOrganizationSession>,
  input: Command,
  {
    operation,
    target,
    request,
    apply,
  }: Readonly<{
    operation: string;
    target: string | null;
    request: unknown;
    apply: (
      client: PoolClient,
      workspaceId: string,
      role: Role,
    ) => Promise<FolderRow>;
  }>,
): Promise<WorkflowFolderCommandResult> {
  return session.command(input, 'governance:manage', async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      operation,
      target,
      idempotencyKey: input.idempotencyKey,
      request,
      apply: async () => {
        const row = await apply(client, scope.workspaceId, scope.role);
        return {
          result: {
            folder: await folderRecord(client, scope.workspaceId, row),
          },
          audit: { action: `workflow.${operation}`, targetId: row.id },
        };
      },
    });
    return Object.freeze({ ...folderResult.parse(result), replayed });
  });
}
