import type { LinkedWorkspace } from './contract.js';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workspaces as workspaceRecords,
  workspaceMemberships,
} from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';

import type { PoolClient } from 'pg';
import { withWorkspaceScope } from '../../../tenant-access/transactions.js';
import { createMemberships } from '../../../tenant-access/members/records.repository.js';
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
        const [state] = await drizzle(scoped)
          .select({ status: workspaceRecords.status })
          .from(workspaceRecords)
          .where(eq(workspaceRecords.id, workspace.workspace_id))
          .catch(rethrowQueryFailure);
        if (state?.status !== 'active') return;
        const [member] = await drizzle(scoped)
          .select({ status: workspaceMemberships.status })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspace.workspace_id),
              eq(workspaceMemberships.userId, userId),
            ),
          )
          .for('update')
          .catch(rethrowQueryFailure);
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
