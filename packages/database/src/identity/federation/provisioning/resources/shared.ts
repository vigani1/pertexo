import { isUniqueConstraintFailure } from '../../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { appendAuditFact } from '../../../../governance/audit/events.repository.js';
import { withWorkspaceScope } from '../../../../tenant-access/transactions.js';
import { DirectoryError } from '../errors.js';
import type { DirectoryPrincipal } from '../contract.js';

export function assertDirectoryRevision(
  actual: number,
  expected: number | undefined,
): void {
  if (expected !== undefined && actual !== expected)
    throw new DirectoryError('stale');
}
export async function directoryAudit(
  client: PoolClient,
  principal: DirectoryPrincipal,
  action: string,
  targetId: string,
): Promise<void> {
  await withWorkspaceScope(
    client,
    { workspaceId: principal.controlWorkspaceId },
    (scoped) =>
      appendAuditFact(scoped, {
        workspaceId: principal.controlWorkspaceId,
        action,
        targetType: 'directory_resource',
        targetId,
        metadata: {
          organizationId: principal.organizationId,
          credentialId: principal.credentialId,
        },
      }),
  );
}
/** Database uniqueness errors contain raw profile values; never expose them to the protocol. */
export async function withDirectoryConstraintErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    const uniqueConstraintFailure = isUniqueConstraintFailure(error);
    if (uniqueConstraintFailure) throw new DirectoryError('uniqueness');
    throw error;
  }
}
