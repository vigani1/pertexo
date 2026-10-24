import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { outboxEvents } from '../../../schema/transport.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { serializeStoredExecutionJsonValue } from '../../../platform/stored-execution-value.js';

export async function assertInvitationDeliveryIdentity(
  client: PoolClient,
  {
    workspaceId,
    invitationId,
    outboxEventId,
  }: Readonly<{
    workspaceId: string;
    invitationId: string;
    outboxEventId: string;
  }>,
): Promise<void> {
  const authoritative = await drizzle(client)
    .select({
      aggregate_id: outboxEvents.aggregateId,
      aggregate_type: outboxEvents.aggregateType,
      job_name: outboxEvents.jobName,
      payload: outboxEvents.payload,
      payload_checksum: outboxEvents.payloadChecksum,
    })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.id, outboxEventId),
      ),
    )
    .catch(rethrowQueryFailure);
  const outbox = authoritative[0];
  const checksum =
    outbox === undefined
      ? undefined
      : createHash('sha256')
          .update(serializeStoredExecutionJsonValue(outbox.payload))
          .digest('hex');
  const invalidDelivery =
    outbox?.aggregate_id !== invitationId ||
    outbox.aggregate_type !== 'workspace-invitation' ||
    outbox.job_name !== 'deliver-workspace-invitation' ||
    outbox.payload_checksum !== checksum;
  if (invalidDelivery)
    throw new Error('Workspace invitation delivery identity mismatch');
}
