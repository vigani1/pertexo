import { entitlementPolicyStateAt } from '../../queries/entitlement-effect.repository.js';
import { lockWorkspaceRunAdmission } from '../../../shared/workspace-fence.repository.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { WorkspaceRunAdmissionDeniedError } from './run-admission.errors.js';
import {
  readAdmissionClock,
  readCurrentEntitlement,
} from './entitlements.repository.js';

/** A workspace takes new runs while it is active and its entitlement is in effect. */
export async function assertWorkspaceAcceptsNewRuns(
  transaction: WorkspaceTransaction,
): Promise<void> {
  const status = await lockWorkspaceRunAdmission(
    transaction.db,
    transaction.workspaceId,
  );
  if (status !== 'active') throw new WorkspaceRunAdmissionDeniedError();
  const entitlement = await readCurrentEntitlement(transaction);
  if (entitlement === undefined) throw new WorkspaceRunAdmissionDeniedError();
  // A SELECT's projection can be evaluated before its row-lock wait. Observe
  // the database clock separately, after both pointer/version share locks.
  const clock = await readAdmissionClock(transaction);
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
      Number(clock),
    ) !== 'active'
  )
    throw new WorkspaceRunAdmissionDeniedError();
}
