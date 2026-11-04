import { entitlementPolicyStateAt } from '../../queries/entitlement-effect.js';
import { lockWorkspaceRunAdmission } from '../../admission-locks.repository.js';
import { and, eq, sql } from 'drizzle-orm';
import {
  workspaceExecutionEntitlements as current,
  workspaceExecutionEntitlementVersions as version,
} from '@pertexo/database/schema';
import { postgresFailure } from '@pertexo/database/primitives';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

import {
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from './run-admission.errors.js';

/** Operation-local SQLSTATE mapping for queued workflow-run admission. */
export function throwWorkflowRunAdmissionError(error: unknown): never {
  const { code } = postgresFailure(error);
  if (code === 'PTA02') throw new WorkspaceRunQuotaExceededError();
  if (code === 'PTA01') throw new WorkspaceRunAdmissionDeniedError();
  throw error;
}

export async function assertWorkspaceAcceptsNewRuns(
  transaction: WorkspaceTransaction,
): Promise<void> {
  const status = await lockWorkspaceRunAdmission(
    transaction.db,
    transaction.workspaceId,
  );
  if (status !== 'active') throw new WorkspaceRunAdmissionDeniedError();
  // lock_workspace_run_admission already holds the current pointer/version
  // shares, for both app and maintenance writers (the latter owns Calls).
  const [entitlement] = await transaction.db
    .select({
      status: version.status,
      effective_at: sql<string>`extract(epoch from ${version.effectiveAt})::text`,
      expires_at: sql<
        string | null
      >`extract(epoch from ${version.expiresAt})::text`,
    })
    .from(current)
    .innerJoin(
      version,
      and(
        eq(version.workspaceId, current.workspaceId),
        eq(version.version, current.currentVersion),
      ),
    )
    .where(eq(current.workspaceId, transaction.workspaceId));
  if (entitlement === undefined) throw new WorkspaceRunAdmissionDeniedError();
  // A SELECT's projection can be evaluated before its row-lock wait. Observe
  // the database clock separately, after both pointer/version share locks.
  const observed = await transaction.db.execute<{ now: string }>(
    sql`select extract(epoch from clock_timestamp())::text now`,
  );
  const clock = observed.rows[0];
  if (clock === undefined) throw new Error('Database clock returned no value');
  if (
    entitlementPolicyStateAt(
      {
        status: entitlement.status,
        effectiveAt: Number(entitlement.effective_at),
        expiresAt:
          entitlement.expires_at === null
            ? null
            : Number(entitlement.expires_at),
      },
      Number(clock.now),
    ) !== 'active'
  )
    throw new WorkspaceRunAdmissionDeniedError();
}
