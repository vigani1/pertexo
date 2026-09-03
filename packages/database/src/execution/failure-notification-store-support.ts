import type { PoolClient } from 'pg';

import { generatePersistedId } from '../persisted-id.js';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

import { canonicalOutboxPayloadChecksum } from './outbox.js';
import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';

export const failureNotificationIdentitySchema = z.uuid();
export const failureNotificationChecksumSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u);

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
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    notificationIntentId: input.intentId,
    outboxEventId,
  } as const;
  await client.query(
    `insert into app.outbox_events (
       id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
       payload,payload_checksum,available_at
     ) values ($1,$2,'deliver-run-failure-notification',1,
       'run-failure-notification',$3,$4::jsonb,$5,$6)
     on conflict (id) do nothing`,
    [
      outboxEventId,
      input.workspaceId,
      input.intentId,
      serializeStoredExecutionJsonValue(payload),
      canonicalOutboxPayloadChecksum(payload),
      input.availableAt,
    ],
  );
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
  await client.query(
    `insert into app.run_failure_notification_audit_facts (
       id,workspace_id,notification_intent_id,fact_type,attempt_number,
       safe_error_code,possibly_dispatched
     ) values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.intentId,
      input.factType,
      input.attemptNumber,
      input.safeErrorCode ?? null,
      input.possiblyDispatched,
    ],
  );
}
