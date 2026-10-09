import type { PoolClient } from 'pg';
import type { z } from 'zod';

import { generatePersistedId } from '../platform/persisted-id.js';
import { canonicalOutboxPayloadChecksum } from '../outbox/events.js';
import { serializeStoredExecutionJsonValue } from '../platform/stored-execution-value.js';
import {
  type completionSchema,
  NodeAttemptStateCorruptError,
} from './contract.js';

type CompletionInput = z.output<typeof completionSchema>;

/** Completion replay compares evidence; absence is a meaningful identity too. */
export async function assertConnectionHealthReplay(
  client: PoolClient,
  input: CompletionInput,
): Promise<void> {
  const result = await client.query<{
    kind: string;
    reason_code: string | null;
  }>(
    'select kind,reason_code from app.connection_health_observations where workspace_id=$1 and attempt_id=$2',
    [input.lease.workspaceId, input.lease.attemptId],
  );
  const actual = result.rows[0];
  const expected = input.connectionHealthObservation;
  if (actual === undefined && expected === undefined) return;
  if (actual === undefined || expected === undefined)
    throw new NodeAttemptStateCorruptError();
  if (
    actual.kind !== expected.kind ||
    actual.reason_code !==
      (expected.kind === 'healthy' ? null : expected.reasonCode)
  )
    throw new NodeAttemptStateCorruptError();
}

/** Called only after the owned lease is accepted, in its outcome transaction. */
export async function persistConnectionHealthObservation(
  client: PoolClient,
  input: CompletionInput,
): Promise<void> {
  const observation = input.connectionHealthObservation;
  if (observation === undefined) return;
  const observationId = generatePersistedId();
  const outboxEventId = generatePersistedId();
  // Only an attempt that dispatched with a recorded connection can report on it.
  const recorded = await client.query(
    `insert into app.connection_health_observations
       (id, workspace_id, attempt_id, kind, reason_code, outbox_event_id)
     select $1, $2, $3, $4, $5, $6
     where exists (select 1 from app.node_attempt_connection_dispatches dispatch
       where dispatch.workspace_id=$2 and dispatch.attempt_id=$3
         and dispatch.worker_id=$7 and dispatch.fence_token=$8)`,
    [
      observationId,
      input.lease.workspaceId,
      input.lease.attemptId,
      observation.kind,
      observation.kind === 'healthy' ? null : observation.reasonCode,
      outboxEventId,
      input.lease.workerId,
      input.lease.fenceToken,
    ],
  );
  if (recorded.rowCount !== 1) throw new NodeAttemptStateCorruptError();
  const payload = {
    schemaVersion: 1,
    workspaceId: input.lease.workspaceId,
    outboxEventId,
    observationId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  };
  await client.query(
    `insert into app.outbox_events(id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,payload,payload_checksum)
    values($1,$2,'apply-connection-health-observation',1,'connection-health-observation',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      input.lease.workspaceId,
      observationId,
      serializeStoredExecutionJsonValue(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
}
