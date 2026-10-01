import type { PoolClient } from 'pg';
import type { z } from 'zod';

import { generatePersistedId } from '../../platform/persisted-id.js';
import { canonicalOutboxPayloadChecksum } from '../transport/outbox.js';
import { serializeStoredExecutionJsonValue } from '../stored-execution-value.js';
import {
  type completionSchema,
  NodeAttemptStateCorruptError,
} from './node-attempt-run-store-contract.js';

type CompletionInput = z.output<typeof completionSchema>;

function expectedObservation(input: CompletionInput) {
  const mode = input.connectionRunHealthMode ?? 'off';
  return mode === 'off' || input.connectionHealthObservation === undefined
    ? undefined
    : { mode, ...input.connectionHealthObservation };
}

/** Completion replay compares evidence; absence is a meaningful identity too. */
export async function assertConnectionHealthReplay(
  client: PoolClient,
  input: CompletionInput,
): Promise<void> {
  const result = await client.query<{
    kind: string;
    reason_code: string | null;
    production_mode: string;
  }>(
    'select kind,reason_code,production_mode from app.connection_health_observations where workspace_id=$1 and attempt_id=$2',
    [input.lease.workspaceId, input.lease.attemptId],
  );
  const actual = result.rows[0];
  const expected = expectedObservation(input);
  if (actual === undefined && expected === undefined) return;
  if (actual === undefined || expected === undefined)
    throw new NodeAttemptStateCorruptError();
  if (
    actual.kind !== expected.kind ||
    actual.production_mode !== expected.mode ||
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
  const observation = expectedObservation(input);
  if (observation === undefined) return;
  const observationId = generatePersistedId();
  const outboxEventId = generatePersistedId();
  await client.query(
    'select app.record_node_attempt_connection_health($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      input.lease.workspaceId,
      input.lease.attemptId,
      input.lease.workerId,
      input.lease.fenceToken,
      observation.kind,
      observation.kind === 'healthy' ? null : observation.reasonCode,
      observation.mode,
      observationId,
      outboxEventId,
    ],
  );
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
