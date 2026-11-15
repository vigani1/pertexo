import { withTenantScopedClient } from '@pertexo/database/primitives';
import type { Pool } from 'pg';
import { WorkflowStepSampleError } from '../step-sample.errors.js';
import { inlineSampleOutput } from '../step-sample-state.js';
import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';
import { WebhookIngressRateLimitExceededError } from '../../../triggers/webhooks/webhook-trigger.errors.js';
import { testEventDraftForCreator } from './test-event-draft.js';
import type {
  TestEventReference,
  TestEventScope,
} from './webhook-test-event.types.js';
import { WebhookTestEventError } from './webhook-test-event.errors.js';
import { lockListener } from './webhook-test-listeners.repository.js';
import {
  listenerAttemptsSpent,
  readListener,
  LISTENER_ATTEMPTS_MAX,
  readPendingListener,
  resolveListenerHash,
  storeTestEvent,
  takeListenerAttempt,
} from './ingress.repository.js';

/**
 * What the test address does for an HTTP sender. No member is acting, so these stay off
 * the authority helper; the listener works while its creator could still edit the workflow.
 */
type Row = NonNullable<Awaited<ReturnType<typeof lockListener>>>;
const scopeOf = (r: Row): TestEventScope => ({
  workspaceId: r.workspaceId,
  workflowId: r.workflowId,
  nodeId: r.nodeId,
  actorId: r.createdBy,
});

export async function consumeTestEventLimit(
  pool: Pool,
  reference: TestEventReference,
): Promise<void> {
  const allowed = await takeListenerAttempt(pool, reference);
  if (!allowed) {
    const limited = await listenerAttemptsSpent(pool, reference);
    if (limited)
      throw new WebhookIngressRateLimitExceededError(LISTENER_ATTEMPTS_MAX);
    throw new WebhookTestEventError('unavailable');
  }
}

export async function captureTestEvent(
  pool: Pool,
  reference: TestEventReference,
  runInput: unknown,
): Promise<boolean> {
  return withTenantScopedClient(
    pool,
    { workspaceId: reference.workspaceId },
    async (client) => {
      // Read authority before the row lock, matching management's lock order.
      const candidate = await readListener(client, reference);
      if (candidate === undefined) return false;
      let draft;
      try {
        draft = await testEventDraftForCreator(client, scopeOf(candidate));
      } catch (error) {
        if (
          error instanceof WorkflowNotFoundError ||
          error instanceof WebhookTestEventError
        )
          return false;
        throw error;
      }
      const row = await lockListener(client, scopeOf(candidate), candidate.id);
      const listenerUnavailable =
        row === undefined ||
        row.expired ||
        row.outputRef !== null ||
        row.binding !== draft.binding;
      if (listenerUnavailable) return false;
      let output;
      try {
        output = inlineSampleOutput({
          kind: 'inline',
          value: runInput,
        });
      } catch (error) {
        if (error instanceof WorkflowStepSampleError)
          throw new WebhookTestEventError('value_invalid');
        throw error;
      }
      await storeTestEvent(client, reference, output);
      return true;
    },
  );
}

export async function resolveTestEventListener(
  pool: Pool,
  hash: string,
): Promise<TestEventReference | null> {
  const resolved = await resolveListenerHash(pool, hash);
  if (resolved === undefined) return null;
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId: resolved.workspace_id },
      async (client) => {
        const row = await readPendingListener(client, resolved, hash);
        if (row === undefined || row.expired) return null;
        const draft = await testEventDraftForCreator(client, scopeOf(row));
        if (draft.binding !== row.binding) return null;
        return {
          endpointId: row.id,
          endpointKeyHash: hash,
          workspaceId: row.workspaceId,
          triggerId: row.id,
          workflowId: row.workflowId,
          nodeId: row.nodeId,
          databaseTime: row.databaseTime,
          authentication: row.authentication,
          ...(draft.config.runInput === undefined
            ? {}
            : { runInputMode: draft.config.runInput }),
          currentSecret: {
            id: row.id,
            triggerId: row.id,
            kmsKeyReference: row.kmsKeyReference,
            encryptedDataKey: row.encryptedDataKey,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            authTag: row.authTag,
          },
        };
      },
    );
  } catch (error) {
    if (
      error instanceof WorkflowNotFoundError ||
      error instanceof WebhookTestEventError
    )
      return null;
    throw error;
  }
}
