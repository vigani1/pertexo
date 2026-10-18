import type { PoolClient } from 'pg';
import { withWorkspaceScope } from '../../../tenant-access/transactions.js';
import { appendAuditFact } from '../../../governance/audit/append.js';
import { SignInProofRejectedError } from '../accounts/rejection.js';

export type LinkedWorkspace = Readonly<{
  workspace_id: string;
  default_role: string;
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
        if (member !== undefined) {
          if (member.status !== 'active') throw new SignInProofRejectedError();
          return;
        }
        await scoped.query(
          "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
          [workspace.workspace_id, userId, workspace.default_role],
        );
        await appendAuditFact(scoped, {
          workspaceId: workspace.workspace_id,
          actorId: userId,
          action: 'identity.membership_created',
          targetType: 'identity_organization',
          targetId: organizationId,
          metadata: { role: workspace.default_role, source: 'jit' },
        });
      },
    );
}
