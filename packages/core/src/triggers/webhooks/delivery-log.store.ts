import { TRIGGER_HISTORY_PAGE_LIMIT } from '../../shared/page-limits.js';
import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';
import type { Pool, PoolClient } from 'pg';
import { withWorkspaceTransaction } from '@pertexo/database/primitives';
import { withWorkflowAccess } from '../../shared/workflow-access.js';
import { WebhookTriggerNotFoundError } from './webhook-trigger.errors.js';
import type {
  ListWebhookDeliveriesInput,
  RejectedWebhookDelivery,
  WebhookDeliveryPage,
} from './webhook-delivery.types.js';
import {
  insertWebhookDelivery,
  readDeliveryPage,
  readTriggerEndpointId,
} from './deliveries.repository.js';

/**
 * Owners, admins and builders read trigger state, on a suspended workspace too. The
 * folder only has to be visible to them. Takes no locks, so it reads one snapshot.
 */
export function withWebhookReader<T>(
  pool: Pool,
  input: Readonly<{ workspaceId: string; actorId: string; workflowId: string }>,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withWorkflowAccess(
    pool,
    {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      workflowId: input.workflowId,
    },
    {
      mode: 'read',
      capability: 'workflow:update',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      folderCapability: 'workflow:read',
      denied: () => new WebhookTriggerNotFoundError(),
    },
    work,
  );
}

export function createWebhookDeliveryLog(pool: Pool) {
  return Object.freeze({
    listDeliveries: (
      input: ListWebhookDeliveriesInput,
    ): Promise<WebhookDeliveryPage> => {
      const { workspaceId } = input;
      const limit = input.limit ?? TRIGGER_HISTORY_PAGE_LIMIT;
      const after = input.after;
      return withWebhookReader(pool, input, async (client) => {
        const endpointId = await readTriggerEndpointId(client, input);
        if (endpointId === undefined) throw new WebhookTriggerNotFoundError();
        if (endpointId === null) return Object.freeze({ items: [] });
        return readDeliveryPage(client, {
          workspaceId,
          endpointId,
          limit,
          after,
        });
      });
    },
    // The sender is the actor here, and has only proved it knows the address.
    recordRejectedDelivery: async (input: RejectedWebhookDelivery) => {
      const outcome = input.outcome;
      await withWorkspaceTransaction(
        pool,
        input.endpoint.workspaceId,
        (transaction) =>
          insertWebhookDelivery(transaction, input.endpoint, {
            outcome,
            signatureCheck: input.signatureCheck,
            replayCheck: input.replayCheck,
            bodyBytes: input.bodyBytes,
          }),
      );
    },
  });
}
