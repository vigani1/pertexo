import type { Role } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { withWorkspaceScope } from '../../../tenant-access/transactions.js';
import { createMemberships } from '../../../tenant-access/members/records.repository.js';

export type LinkedWorkspace = Readonly<{
  workspace_id: string;
  default_role: Role;
}>;
/** Existing manual grants stay manual; suspension and removal cannot be resurrected by JIT. */
export async function grantJustInTimeMemberships(
  client: PoolClient,
  workspaces: readonly LinkedWorkspace[],
  userId: string,
  organizationId: string,
): Promise<void> {
  for (const workspace of workspaces)
    await withWorkspaceScope(
      client,
      { workspaceId: workspace.workspace_id },
      async (scoped) => {
        const state = (
          await scoped.query<{ status: string }>(
            'select status from app.workspaces where id=$1',
            [workspace.workspace_id],
          )
        ).rows[0];
        if (state?.status !== 'active') return;
        const member = (
          await scoped.query<{ status: string }>(
            'select status from app.workspace_memberships where workspace_id=$1 and user_id=$2 for update',
            [workspace.workspace_id, userId],
          )
        ).rows[0];
        if (member !== undefined) return;
        await createMemberships(
          scoped,
          workspace.workspace_id,
          [
            {
              userId,
              role: workspace.default_role,
              source: 'jit',
              organizationId,
            },
          ],
          { actorId: userId },
        );
      },
    );
}
