import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { MAX_AUTO_PAUSE_THRESHOLD } from '@pertexo/policy';
import type { HttpPollFailureCode } from '@pertexo/workflow-model';
import {
  lockAutoPauseWorkflow,
  lockAutoPauseWorkspace,
} from '../pause/locks.repository.js';
import { writeTriggerPause } from '../pause/write-pause.repository.js';
import { lockWorkspaceRunAdmission } from '../../shared/access/workspace-fence.repository.js';
import type { PollClaim } from '../schedules/scanning/schedule-scanning.types.js';
import { PollClaimLostError } from './poll.errors.js';
import { completePoll, lockPollPublication } from './progress.repository.js';

export async function recordPollFailure(
  transaction: WorkspaceTransaction,
  claim: PollClaim,
  observation: Readonly<{ workflowId: string; pauseRevision: bigint }>,
  {
    code,
    delaySeconds,
  }: Readonly<{ code: HttpPollFailureCode; delaySeconds: number }>,
) {
  const workspaceId = claim.workspace_id;
  const { workflowId, pauseRevision } = observation;
  await lockAutoPauseWorkspace(transaction, workspaceId, false);
  if (
    (await lockWorkspaceRunAdmission(transaction.db, workspaceId)) !== 'active'
  )
    throw new PollClaimLostError();
  await lockAutoPauseWorkflow(transaction, workspaceId, workflowId);
  const current = await lockPollPublication(
    transaction,
    claim,
    pauseRevision,
    'no key update',
  );
  if (current === undefined) throw new PollClaimLostError();

  const previous =
    current.failurePauseRevision === pauseRevision
      ? current.consecutiveFailures
      : 0;
  const count = Math.min(previous + 1, MAX_AUTO_PAUSE_THRESHOLD);
  const { autoPauseEnabled, threshold } = current.published;
  const shouldPause =
    code === 'http.poll_authentication' ||
    (autoPauseEnabled && count >= threshold);
  // A repaired feed can be checked as soon as the workflow resumes.
  if (
    !(await completePoll(transaction, claim, shouldPause ? 0 : delaySeconds, {
      kind: 'failure',
      code,
      count,
      pauseRevision,
    }))
  )
    throw new PollClaimLostError();

  if (!shouldPause) return 'skipped';
  await writeTriggerPause(
    transaction,
    { workspaceId, workflowId },
    {
      kind: 'poll',
      triggerId: claim.trigger_id,
      errorCode: code,
      failures: count,
    },
    threshold,
  );
  return 'paused';
}
