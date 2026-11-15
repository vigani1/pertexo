import { lockCapabilityExecution } from './fence.js';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { publishesSlackBinding } from './slack-binding.js';
import {
  DISPATCHABLE_RUN_STATUSES,
  lockLeasedNodeBinding,
  markLeasedAttemptDispatched,
  readPublishedExecutable,
  readRunDispatchControl,
  recordSlackDispatch,
  saveDispatchBinding,
} from './dispatch-marks.repository.js';
import type { Pool, PoolClient } from 'pg';
import {
  NodeAttemptConnectionFenceError,
  NodeAttemptRunAbortedError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptReconciliationRequiredError,
} from '../node-attempt.errors.js';
import type { MarkDispatchedInput } from '../node-attempt.js';
import { isConnectionFenceCurrent } from '../../connections/runtime/credential-use.repository.js';

export async function markNodeAttemptDispatched(
  pool: Pool,
  input: MarkDispatchedInput,
): Promise<Readonly<{ dispatchedAt: Date }>> {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.lease.workspaceId },
    async (client) => {
      await lockCapabilityExecution(client, input.lease);
      if (input.connectionFence !== undefined) {
        const current = await isConnectionFenceCurrent(
          client,
          input.lease.workspaceId,
          {
            connectionId: input.connectionFence.connectionId,
            providerKey: input.connectionFence.expectedProviderKey,
            authType: input.connectionFence.expectedAuthType,
            secretVersionId: input.connectionFence.secretVersionId,
          },
        );
        if (!current) throw new NodeAttemptConnectionFenceError();
      }
      const lease = input.lease;
      const existingBinding = await lockLeasedNodeBinding(client, lease);
      if (existingBinding === undefined)
        throw new NodeAttemptReconciliationRequiredError();
      await assertRunDispatchControl(client, input.lease);
      const dispatchBindingChanged =
        input.providerDispatchBinding !== undefined &&
        existingBinding !== null &&
        existingBinding !== input.providerDispatchBinding;
      if (dispatchBindingChanged)
        throw new NodeAttemptDispatchBindingMismatchError();
      if (
        input.providerDispatchBinding !== undefined &&
        existingBinding === null
      )
        await saveDispatchBinding(client, lease, input.providerDispatchBinding);
      const dispatchedAt = await markLeasedAttemptDispatched(client, lease);
      if (dispatchedAt === undefined) {
        await assertRunDispatchControl(client, input.lease);
        throw new NodeAttemptReconciliationRequiredError();
      }
      await persistSlackDispatch(client, input);
      return Object.freeze({ dispatchedAt: new Date(dispatchedAt) });
    },
    { signal: input.signal },
  );
}

/** Checked after prerequisite locks and again if the marker's database-time fence refuses. */
async function assertRunDispatchControl(
  client: PoolClient,
  lease: MarkDispatchedInput['lease'],
): Promise<void> {
  const control = await readRunDispatchControl(client, lease);
  if (
    control === undefined ||
    !DISPATCHABLE_RUN_STATUSES.some((status) => status === control.status)
  )
    throw new NodeAttemptReconciliationRequiredError();
  if (control.reason !== null)
    throw new NodeAttemptRunAbortedError(control.reason);
}

async function persistSlackDispatch(
  client: PoolClient,
  input: MarkDispatchedInput,
): Promise<void> {
  const lease = input.lease;
  // A Slack send remembers the secret and health revision it used, so a
  // run's later auth failure can mark exactly that connection state. Only
  // the published node's own bot-token connection is recorded.
  if (
    input.connectionFence?.expectedProviderKey === 'slack' &&
    input.connectionFence.expectedAuthType === 'slack_bot_token'
  ) {
    const executableJson = await readPublishedExecutable(client, lease);
    if (
      !publishesSlackBinding(
        executableJson,
        input.lease.nodeId,
        input.connectionFence.connectionId,
      )
    )
      throw new NodeAttemptDispatchBindingMismatchError(
        'Connection dispatch published binding mismatch',
      );
    await recordSlackDispatch(client, lease, input.connectionFence);
  }
}
