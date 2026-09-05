import { z } from 'zod';

import type { LeasedOutboxEvent } from './dispatcher.js';
import { sha256HexSchema } from '../validation/persisted-primitives.js';

const claimedRowSchema = z
  .object({
    aggregate_id: z.uuid(),
    aggregate_type: z.string().min(1).max(128),
    available_at: z.coerce.date(),
    id: z.uuid(),
    job_name: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u),
    lease_expires_at: z.coerce.date(),
    lease_owner: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
    lease_token: z.uuid(),
    payload: z.unknown(),
    payload_checksum: sha256HexSchema,
    publish_attempts: z.number().int().positive(),
    schema_version: z.number().int().positive(),
    workspace_id: z.uuid(),
  })
  .strict();
export const claimQueryResultSchema = z
  .object({
    events: z.array(claimedRowSchema),
    exhausted_count: z.number().int().nonnegative(),
    cursor_update_count: z.number().int().nonnegative(),
    released_admission_count: z.number().int().nonnegative(),
  })
  .strict();

export function toLeasedEvent(
  row: z.output<typeof claimedRowSchema>,
): LeasedOutboxEvent {
  return Object.freeze({
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    availableAt: row.available_at,
    id: row.id,
    jobName: row.job_name,
    leaseExpiresAt: row.lease_expires_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    payload: row.payload,
    payloadChecksum: row.payload_checksum,
    publishAttempts: row.publish_attempts,
    schemaVersion: row.schema_version,
    workspaceId: row.workspace_id,
  });
}
