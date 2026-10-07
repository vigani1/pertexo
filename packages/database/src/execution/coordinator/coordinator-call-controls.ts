import type { PoolClient } from 'pg';
import { z } from 'zod';
import { v5 as uuidv5 } from 'uuid';
import {
  parseWorkspaceId,
  workspaceTransactionFromClient,
} from '../../tenant-access/workspace.js';
import { appendLockedRunEvent, RUN_EVENT_TYPE } from '../runs/run-events.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../transport/outbox.js';
import type { CoordinatorAdvanceDelivery } from './coordinator-run-store-contract.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';

const intentResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unchanged') }).strict(),
  z.object({ kind: z.literal('wake') }).strict(),
  z.object({ kind: z.literal('requested') }).strict(),
]);
const controlResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unchanged') }).strict(),
  z.object({ kind: z.literal('wake') }).strict(),
  z
    .object({
      kind: z.literal('requested'),
      actor: z.string().min(1).max(128),
      reason: z.string().max(512).nullable(),
    })
    .strict(),
]);

/**
 * Parent-owned intent only: no child row locks, control mutation or audit.
 * UUIDv5 namespace is the actual parent delivery UUID; its UTF-8 name is the
 * JSON tuple [domain, revision, canonical child UUID, closed control reason].
 */
export async function persistCoordinatorCallControls(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: ParsedTransitionPlan;
    delivery: CoordinatorAdvanceDelivery;
    traceparent?: string;
  }>,
): Promise<void> {
  const transaction = workspaceTransactionFromClient(
    client,
    parseWorkspaceId(input.workspaceId),
  );
  const children = [...(input.plan.workflowCalls?.cancelChildren ?? [])].sort(
    (left, right) => left.childRunId.localeCompare(right.childRunId),
  );
  for (const child of children) {
    const outboxEventId = uuidv5(
      JSON.stringify([
        'pertexo.workflow-call-control.v1',
        input.plan.expectedRevision,
        child.childRunId.toLowerCase(),
        child.reason,
      ]),
      input.delivery.outboxEventId,
    );
    const result = await client.query<{ result: unknown }>(
      `select app.propagate_workflow_call_control($1::uuid,$2::integer,$3::uuid,$4::text,$5::jsonb) as result`,
      [
        input.runId,
        input.plan.expectedRevision,
        child.childRunId,
        child.reason,
        JSON.stringify(input.delivery),
      ],
    );
    if (result.rows.length !== 1)
      throw new TypeError('Workflow Call control result missing');
    const outcome = intentResult.parse(result.rows[0]?.result);
    if (outcome.kind === 'unchanged') continue;
    const payload = {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      runId: child.childRunId,
      outboxEventId,
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    };
    const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
    // The parent row lock serializes replay of this exact intent. Existing
    // immutable content must match completely; never hide a unique collision.
    const existing = await client.query<{
      job_name: string;
      schema_version: number;
      aggregate_type: string;
      aggregate_id: string;
      payload: unknown;
      payload_checksum: string;
    }>(
      `select job_name,schema_version,aggregate_type,aggregate_id,payload,payload_checksum
       from app.outbox_events where workspace_id=$1 and id=$2`,
      [input.workspaceId, outboxEventId],
    );
    if (existing.rows.length !== 0) {
      const row = existing.rows[0];
      if (
        existing.rows.length !== 1 ||
        row?.job_name !== 'advance-workflow-run' ||
        row.schema_version !== 1 ||
        row.aggregate_type !== 'workflow-run' ||
        row.aggregate_id !== child.childRunId ||
        row.payload_checksum !== payloadChecksum ||
        canonicalOutboxPayloadChecksum(row.payload) !== payloadChecksum
      )
        throw new TypeError('Workflow Call control intent conflict');
      continue;
    }
    await insertOutboxEvent(transaction, {
      id: outboxEventId,
      jobName: 'advance-workflow-run',
      schemaVersion: 1,
      aggregateType: 'workflow-run',
      aggregateId: child.childRunId,
      payload,
      payloadChecksum,
    });
  }
}

/** Own-run protected cancellation and its audit commit atomically before read. */
export async function applyCoordinatorCallControl(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    delivery: CoordinatorAdvanceDelivery;
  }>,
): Promise<void> {
  const result = await client.query<{ result: unknown }>(
    'select app.apply_workflow_call_control($1::uuid,$2::jsonb) as result',
    [input.runId, JSON.stringify(input.delivery)],
  );
  if (result.rows.length !== 1)
    throw new TypeError('Workflow Call apply result missing');
  const outcome = controlResult.parse(result.rows[0]?.result);
  if (outcome.kind === 'requested') {
    await appendLockedRunEvent(
      workspaceTransactionFromClient(
        client,
        parseWorkspaceId(input.workspaceId),
      ),
      input.runId,
      {
        type: RUN_EVENT_TYPE.cancelRequested,
        payload: {
          actor: outcome.actor,
          ...(outcome.reason === null ? {} : { reason: outcome.reason }),
        },
      },
    );
  }
}
