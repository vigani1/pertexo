import {
  ADMINISTRATIVE_ROLES,
  WORKFLOW_EDITOR_ROLES,
} from '@pertexo/workflow-model';

import type { PoolClient } from 'pg';

import { runOrganizationCommand } from '../../commands.repository.js';

import type { createOrganizationSession } from '../../session.js';
import type { Command, WorkflowFolderCommandResult } from '../contract.js';
import { folderResult } from '../input.js';
import { type FolderRow, folderRecord } from '../hierarchy.queries.js';

export const ADMINISTRATORS = ADMINISTRATIVE_ROLES;

export const EDITORS = WORKFLOW_EDITOR_ROLES;

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
    apply: (client: PoolClient, workspaceId: string) => Promise<FolderRow>;
  }>,
): Promise<WorkflowFolderCommandResult> {
  return session.transact(input, async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      operation,
      target,
      idempotencyKey: input.idempotencyKey,
      request,
      roles: ADMINISTRATORS,
      apply: async () => {
        const row = await apply(client, scope.workspaceId);
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
