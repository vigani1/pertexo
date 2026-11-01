import type { PoolClient } from 'pg';
import type { GovernanceSettings } from '@pertexo/contracts';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaces } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { GovernanceError } from '../contract.js';

export async function readGovernanceSettings(
  client: PoolClient,
  workspaceId: string,
): Promise<GovernanceSettings> {
  const [row] = await drizzle(client)
    .select({
      revision: workspaces.governanceRevision,
      auditRetentionDays: workspaces.auditRetentionDays,
      requirePublishApproval: workspaces.requirePublishApproval,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new GovernanceError(
      'conflict',
      'Workspace settings are unavailable.',
    );
  return row;
}
