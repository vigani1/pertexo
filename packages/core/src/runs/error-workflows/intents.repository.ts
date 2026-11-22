import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import {
  runErrorWorkflowIntents,
  workflows,
  workflowErrorPolicies,
  workflowRuns,
  outboxEvents,
  databaseSchema,
} from '@pertexo/database/schema';
import { and, eq, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  rethrowQueryFailure,
  parseWorkspaceId,
  canonicalOutboxPayloadChecksum,
} from '@pertexo/database/primitives';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { ErrorWorkflowDeliveryInput } from './error-workflow-delivery.types.js';

export type ErrorWorkflowRefusalCode = NonNullable<
  (typeof runErrorWorkflowIntents.$inferSelect)['refusalCode']
>;

const intent = runErrorWorkflowIntents;
const ofSource = (input: ErrorWorkflowDeliveryInput) =>
  and(
    eq(intent.workspaceId, input.workspaceId),
    eq(intent.sourceRunId, input.sourceRunId),
  );

/** An error workflow's acceptance runs on the delivery's client. */
export function errorWorkflowTransaction(
  client: PoolClient,
  workspaceId: string,
): WorkspaceTransaction {
  return {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(workspaceId),
  };
}

export async function readErrorWorkflowCandidate(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
) {
  const [candidate] = await drizzle(client)
    .select({
      target_workflow_id: intent.targetWorkflowId,
      target_version_id: intent.targetVersionId,
    })
    .from(intent)
    .where(ofSource(input))
    .catch(rethrowQueryFailure);
  return candidate;
}

export async function lockErrorWorkflowTarget(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; workflowId: string }>,
) {
  const [target] = await drizzle(client)
    .select({ lifecycle_status: workflows.lifecycleStatus })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return target;
}

export async function lockErrorWorkflowIntent(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
) {
  const [row] = await drizzle(client)
    .select({
      status: intent.status,
      context: intent.context,
      outbox_event_id: intent.outboxEventId,
      queue_wait_expires_at: intent.queueWaitExpiresAt,
    })
    .from(intent)
    .where(ofSource(input))
    .for('update')
    .catch(rethrowQueryFailure);
  return row;
}

/** Whether the intent's wait for queue room has run out. */
export async function errorWorkflowQueueWaitExpired(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
) {
  const expired = await drizzle(client)
    .select({ one: sql`1` })
    .from(intent)
    .where(
      and(
        eq(intent.workspaceId, input.workspaceId),
        eq(intent.sourceRunId, input.sourceRunId),
        lte(intent.queueWaitExpiresAt, sql`clock_timestamp()`),
      ),
    )
    .catch(rethrowQueryFailure);
  return expired.length === 1;
}

export async function openErrorWorkflowAdmission(client: PoolClient) {
  await drizzle(client)
    .execute(sql`savepoint error_workflow_admission`)
    .catch(rethrowQueryFailure);
}

export async function keepErrorWorkflowAdmission(client: PoolClient) {
  await drizzle(client)
    .execute(sql`release savepoint error_workflow_admission`)
    .catch(rethrowQueryFailure);
}

export async function discardErrorWorkflowAdmission(client: PoolClient) {
  await drizzle(client)
    .execute(sql`rollback to savepoint error_workflow_admission`)
    .catch(rethrowQueryFailure);
  await keepErrorWorkflowAdmission(client);
}

export async function markErrorWorkflowAccepted(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
  runId: string,
) {
  await drizzle(client)
    .update(intent)
    .set({
      status: 'accepted',
      acceptedRunId: runId,
      completedAt: sql`clock_timestamp()`,
    })
    .where(ofSource(input))
    .catch(rethrowQueryFailure);
}

export async function refuseErrorWorkflow(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
  code: ErrorWorkflowRefusalCode,
): Promise<void> {
  await drizzle(client)
    .update(intent)
    .set({
      status: 'refused',
      refusalCode: code,
      completedAt: sql`clock_timestamp()`,
    })
    .where(ofSource(input))
    .catch(rethrowQueryFailure);
}

/** The workflow's error policy target, unless the failed run is itself an error workflow's. */
export async function readErrorWorkflowPolicy(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; runId: string; workflowId: string }>,
) {
  const source = alias(workflows, 'source'),
    target = alias(workflows, 'target');
  const [row] = await drizzle(client)
    .select({
      target_workflow_id: target.id,
      target_version_id: target.publishedVersionId,
      workflow_name: source.name,
    })
    .from(workflowErrorPolicies)
    .innerJoin(
      source,
      and(
        eq(source.workspaceId, workflowErrorPolicies.workspaceId),
        eq(source.id, workflowErrorPolicies.workflowId),
      ),
    )
    .innerJoin(
      target,
      and(
        eq(target.workspaceId, workflowErrorPolicies.workspaceId),
        eq(target.id, workflowErrorPolicies.targetWorkflowId),
      ),
    )
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, workflowErrorPolicies.workspaceId),
        eq(workflowRuns.id, input.runId),
      ),
    )
    .where(
      and(
        eq(workflowErrorPolicies.workspaceId, input.workspaceId),
        eq(workflowErrorPolicies.workflowId, input.workflowId),
        eq(workflowRuns.errorWorkflowOrigin, false),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}

export async function insertRefusedErrorWorkflowIntent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    targetWorkflowId: string;
    context: unknown;
  }>,
) {
  await drizzle(client)
    .insert(runErrorWorkflowIntents)
    .values({
      workspaceId: input.workspaceId,
      sourceRunId: input.runId,
      targetWorkflowId: input.targetWorkflowId,
      targetVersionId: null,
      context: input.context,
      outboxEventId: null,
      status: 'refused',
      refusalCode: 'target_not_published',
      completedAt: sql`clock_timestamp()`,
    })
    .onConflictDoNothing({
      target: [
        runErrorWorkflowIntents.workspaceId,
        runErrorWorkflowIntents.sourceRunId,
      ],
    })
    .catch(rethrowQueryFailure);
}

/** Saves the pending intent; false when the source run already has one. */
export async function insertErrorWorkflowIntent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    targetWorkflowId: string;
    targetVersionId: string;
    context: unknown;
    outboxEventId: string;
  }>,
) {
  const inserted = await drizzle(client)
    .insert(runErrorWorkflowIntents)
    .values({
      workspaceId: input.workspaceId,
      sourceRunId: input.runId,
      targetWorkflowId: input.targetWorkflowId,
      targetVersionId: input.targetVersionId,
      context: input.context,
      outboxEventId: input.outboxEventId,
    })
    .onConflictDoNothing({
      target: [
        runErrorWorkflowIntents.workspaceId,
        runErrorWorkflowIntents.sourceRunId,
      ],
    })
    .returning({ id: runErrorWorkflowIntents.sourceRunId })
    .catch(rethrowQueryFailure);
  return inserted.length === 1;
}

export async function enqueueErrorWorkflowStart(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    outboxEventId: string;
    payload: Readonly<Record<string, unknown>>;
  }>,
) {
  const { outboxEventId, payload } = input;
  await drizzle(client)
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId: input.workspaceId,
      jobName: 'start-error-workflow',
      aggregateType: 'workflow-run',
      aggregateId: input.runId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    })
    .catch(rethrowQueryFailure);
}
