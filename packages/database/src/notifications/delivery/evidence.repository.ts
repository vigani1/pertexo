import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { outboxEvents } from '../../schema/transport.js';
import { runFailureNotificationAuditFacts } from '../../schema/runs/completion/notifications.js';
import type { PoolClient } from 'pg';

import { generatePersistedId } from '../../platform/persisted-id.js';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

import { canonicalOutboxPayloadChecksum } from '../../outbox/events.js';
import { sha256HexSchema } from '../../platform/persisted-primitives.js';

export const failureNotificationIdentitySchema = z.uuid();
export const failureNotificationChecksumSchema = sha256HexSchema;

export async function insertFailureNotificationDeliveryOutbox(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    intentId: string;
    attemptNumber: number;
    availableAt: Date;
  }>,
): Promise<void> {
  const outboxEventId = uuidv5(
    `delivery:${String(input.attemptNumber)}`,
    input.intentId,
  );
  const payload = {
    workspaceId: input.workspaceId,
    notificationIntentId: input.intentId,
    outboxEventId,
  } as const;
  await drizzle(client)
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId: input.workspaceId,
      jobName: 'deliver-run-failure-notification',
      aggregateType: 'run-failure-notification',
      aggregateId: input.intentId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      availableAt: input.availableAt,
    })
    .onConflictDoNothing({ target: outboxEvents.id })
    .catch(rethrowQueryFailure);
}

export async function auditFailureNotification(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    intentId: string;
    factType: string;
    attemptNumber: number;
    safeErrorCode?: string;
    possiblyDispatched: boolean;
  }>,
): Promise<void> {
  await drizzle(client)
    .insert(runFailureNotificationAuditFacts)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      notificationIntentId: input.intentId,
      factType: input.factType,
      attemptNumber: input.attemptNumber,
      safeErrorCode: input.safeErrorCode ?? null,
      possiblyDispatched: input.possiblyDispatched,
    })
    .catch(rethrowQueryFailure);
}
