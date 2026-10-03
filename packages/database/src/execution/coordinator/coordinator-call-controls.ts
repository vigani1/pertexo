import type { PoolClient } from 'pg';
import { z } from 'zod';
import { generatePersistedId } from '../../platform/persisted-id.js';
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

/** Protected control columns, existing event/outbox owners, same parent CAS transaction. */
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
    const outboxEventId = generatePersistedId();
    const result = await client.query<{ result: unknown }>(
      `select app.propagate_workflow_call_control($1::uuid,$2::integer,$3::uuid,$4::text,$5::jsonb,$6::uuid) as result`,
      [
        input.runId,
        input.plan.expectedRevision,
        child.childRunId,
        child.reason,
        JSON.stringify(input.delivery),
        outboxEventId,
      ],
    );
    if (result.rows.length !== 1)
      throw new TypeError('Workflow Call control result missing');
    const outcome = controlResult.parse(result.rows[0]?.result);
    if (outcome.kind === 'unchanged') continue;
    if (outcome.kind === 'requested')
      await appendLockedRunEvent(transaction, child.childRunId, {
        type: RUN_EVENT_TYPE.cancelRequested,
        payload: {
          actor: outcome.actor,
          ...(outcome.reason === null ? {} : { reason: outcome.reason }),
        },
      });
    const payload = {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      runId: child.childRunId,
      outboxEventId,
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    };
    await insertOutboxEvent(transaction, {
      id: outboxEventId,
      jobName: 'advance-workflow-run',
      schemaVersion: 1,
      aggregateType: 'workflow-run',
      aggregateId: child.childRunId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    });
  }
}
