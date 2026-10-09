import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkspaceDatabase } from '../../database.js';
import { sha256HexSchema } from '../../platform/persisted-primitives.js';
import {
  consumeInboxMessage,
  InboxReceiptUnavailableError,
} from '../../outbox/receipts.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.js';

const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    observationId: z.uuid(),
    traceparent: z
      .string()
      .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
      .optional(),
  })
  .strict();
const inputSchema = z
  .object({
    workspaceId: z.uuid(),
    observationId: z.uuid(),
    delivery: z
      .object({ outboxEventId: z.uuid(), payloadChecksum: sha256HexSchema })
      .strict(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

export type ConnectionHealthApplicationResult = Readonly<{
  kind: 'applied' | 'stale' | 'duplicate';
}>;

type Transaction = Parameters<Parameters<typeof consumeInboxMessage>[3]>[0];

/**
 * Applies one run's observation once. Only an observation about the exact
 * connection secret and health revision the attempt dispatched with,
 * after the attempt ended, changes the connection: a healthy one refreshes
 * it, any other marks it as needing reauthorization.
 */
async function applyObservation(
  transaction: Transaction,
  input: z.output<typeof inputSchema>,
): Promise<boolean> {
  const workspaceId = transaction.workspaceId;
  const observations = await transaction.db.execute<{
    attempt_id: string;
    kind: string;
    reason_code: string | null;
    observed_at: Date;
    outbox_event_id: string;
    applied: boolean;
  }>(sql`
    select attempt_id, kind, reason_code, observed_at,
           outbox_event_id, applied_at is not null applied
    from app.connection_health_observations
    where workspace_id=${workspaceId} and id=${input.observationId}
    for update`);
  const observation = observations.rows[0];
  if (observation === undefined || observation.applied) return false;
  if (observation.outbox_event_id !== input.delivery.outboxEventId)
    throw new InboxReceiptUnavailableError();
  const dispatches = await transaction.db.execute<{
    connection_id: string;
    secret_version_id: string;
    health_revision: string;
  }>(sql`
    select connection_id, secret_version_id, health_revision::text
    from app.node_attempt_connection_dispatches
    where workspace_id=${workspaceId} and attempt_id=${observation.attempt_id}`);
  const dispatch = dispatches.rows[0];
  if (dispatch === undefined) return false;
  await transaction.db.execute(sql`
    update app.connection_health_observations set applied_at=clock_timestamp()
    where workspace_id=${workspaceId} and id=${input.observationId}`);
  const connections = await transaction.db.execute<{
    status: string;
    current_secret_version_id: string;
    health_revision: string;
    provider_key: string;
    auth_type: string;
  }>(sql`
    select status, current_secret_version_id, health_revision::text,
           provider_key, auth_type
    from app.connections
    where workspace_id=${workspaceId} and id=${dispatch.connection_id}
    for update`);
  const connection = connections.rows[0];
  if (
    connection === undefined ||
    connection.status === 'revoked' ||
    connection.current_secret_version_id !== dispatch.secret_version_id ||
    connection.health_revision !== dispatch.health_revision ||
    connection.provider_key !== 'slack' ||
    connection.auth_type !== 'slack_bot_token'
  )
    return false;
  const ended = await transaction.db.execute(sql`
    select 1 from app.node_attempts
    where workspace_id=${workspaceId} and id=${observation.attempt_id}
      and dispatch_marked_at is not null
      and status in ('succeeded','failed','canceled','timed_out','outcome_unknown')`);
  if (ended.rows.length !== 1) return false;
  if (observation.kind === 'healthy') {
    if (connection.status !== 'active') return false;
    await transaction.db.execute(sql`
      update app.connections
      set last_healthy_at=greatest(last_healthy_at, ${observation.observed_at}),
          last_run_observed_at=greatest(last_run_observed_at, ${observation.observed_at}),
          last_error_code=null, updated_at=clock_timestamp()
      where workspace_id=${workspaceId} and id=${dispatch.connection_id}`);
    return true;
  }
  await transaction.db.execute(sql`
    update app.connections
    set status='reauthorization_required', health_revision=health_revision+1,
        last_error_code=${observation.reason_code},
        last_run_observed_at=${observation.observed_at},
        last_health_transition_at=clock_timestamp(),
        last_health_transition_source='run', updated_at=clock_timestamp()
    where workspace_id=${workspaceId} and id=${dispatch.connection_id}`);
  await transaction.db.execute(sql`
    insert into app.connection_events
      (id, workspace_id, connection_id, event_type, actor_kind, actor_id, metadata)
    values (${input.observationId}, ${workspaceId}, ${dispatch.connection_id},
            'connection.reauthorization_required', 'worker',
            'connection-health-worker',
            jsonb_build_object('source', 'run', 'status', 'reauthorization_required',
                               'reasonCode', ${observation.reason_code}::text))`);
  return true;
}

/** Consumes persisted IDs, never a caller-chosen connection/status/reason. */
export async function applyConnectionHealthObservation(
  database: WorkspaceDatabase,
  input: Readonly<z.input<typeof inputSchema>>,
): Promise<ConnectionHealthApplicationResult> {
  const parsed = inputSchema.parse(input);
  parsed.signal?.throwIfAborted();
  const consumed = await consumeInboxMessage(
    database,
    parsed.workspaceId,
    {
      consumerName: 'connection-health-worker',
      messageId: parsed.delivery.outboxEventId,
      payloadChecksum: parsed.delivery.payloadChecksum,
    },
    async (transaction) => {
      const outbox = await transaction.db.execute<{
        aggregate_id: string;
        aggregate_type: string;
        job_name: string;
        schema_version: number;
        payload: unknown;
        payload_checksum: string;
      }>(sql`
      select aggregate_id,aggregate_type,job_name,schema_version,payload,payload_checksum from app.outbox_events
      where workspace_id=${transaction.workspaceId} and id=${parsed.delivery.outboxEventId}`);
      const row = outbox.rows[0];
      if (row === undefined) {
        const remaining = await transaction.db
          .execute(sql`select id from app.connection_health_observations
        where workspace_id=${transaction.workspaceId} and id=${parsed.observationId}`);
        if (remaining.rows.length !== 0)
          throw new InboxReceiptUnavailableError();
        // Retention deletes source evidence and its command together. A delayed
        // delivery cannot resurrect either or modify a connection.
        return false;
      }
      const payload = payloadSchema.safeParse(row.payload);
      if (
        !payload.success ||
        row.aggregate_id !== parsed.observationId ||
        row.aggregate_type !== 'connection-health-observation' ||
        row.job_name !== 'apply-connection-health-observation' ||
        row.schema_version !== 1 ||
        row.payload_checksum !== parsed.delivery.payloadChecksum ||
        canonicalOutboxPayloadChecksum(payload.data) !== row.payload_checksum ||
        payload.data.workspaceId !== transaction.workspaceId ||
        payload.data.outboxEventId !== parsed.delivery.outboxEventId ||
        payload.data.observationId !== parsed.observationId
      )
        throw new InboxReceiptUnavailableError();
      return applyObservation(transaction, parsed);
    },
    {
      lockWorkspace: true,
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
    },
  );
  return Object.freeze({
    kind:
      consumed.status === 'duplicate'
        ? 'duplicate'
        : consumed.value
          ? 'applied'
          : 'stale',
  });
}
