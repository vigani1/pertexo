import { notificationFailures } from '@pertexo/workflow-engine';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  nodeRuns,
  workflowRuns,
  runFailureNotificationIntents,
  outboxEvents,
} from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  canonicalOutboxPayloadChecksum,
  serializeStoredExecutionJsonValue,
} from '@pertexo/database/primitives';
import { auditFailureNotification } from '../../../notifications/delivery/evidence.repository.js';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { v5 as uuidv5 } from 'uuid';
import {
  FAILURE_NOTIFICATION_CONTEXT_MAX_BYTES,
  FailureNotificationContextSchema,
} from '@pertexo/workflow-model';
import { CoordinatorRunStateCorruptError } from '../../state-errors.js';
import type { RunTransitionPlan } from '../plan.js';

const failureNotificationNamespace = '9fe280d8-40ca-4a20-930e-1bf77e48c817';

export async function persistFailureNotificationIntent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    workflowId: string;
    workflowVersionId: string;
    triggerType: string;
    startedAt: Date | null;
    createdAt: Date;
    destinationId: string | null;
    destinationConfigVersion: number | null;
    sideEffectClass: string | null;
    cancellationRequested: boolean;
    plan: RunTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  const terminalEvent = input.plan.events.find(
    ({ name }) =>
      name === `run.${input.plan.checkpoint.runStatus}` &&
      ['run.failed', 'run.timed_out', 'run.outcome_unknown'].includes(name),
  );
  const notificationUnavailable =
    terminalEvent === undefined ||
    input.cancellationRequested ||
    input.destinationId === null ||
    input.destinationConfigVersion === null ||
    input.sideEffectClass === null;
  if (notificationUnavailable) return;

  const failures = notificationFailures(input.plan.checkpoint);
  const primary = failures[0];
  const primaryFailure = await readPrimaryFailure(client, input, {
    primary,
    terminalEvent,
  });
  const context = FailureNotificationContextSchema.parse({
    runId: input.runId,
    workflowId: input.workflowId,
    workflowVersionId: input.workflowVersionId,
    terminalEventSequence: terminalEvent.sequence,
    terminalStatus: input.plan.checkpoint.runStatus,
    triggerType: input.triggerType,
    startedAt: (input.startedAt ?? input.createdAt).toISOString(),
    completedAt: terminalEvent.occurredAt,
    primaryFailure,
    totalFailureCount: Math.max(1, failures.length),
  });
  const contextJson = serializeStoredExecutionJsonValue(context);
  if (utf8ByteLength(contextJson) > FAILURE_NOTIFICATION_CONTEXT_MAX_BYTES)
    throw new CoordinatorRunStateCorruptError();
  const contextChecksum = createHash('sha256')
    .update(contextJson)
    .digest('hex');
  const intentId = uuidv5(
    `${input.runId}:${String(terminalEvent.sequence)}`,
    failureNotificationNamespace,
  );
  const outboxEventId = uuidv5('delivery:1', intentId);
  const payload = {
    workspaceId: input.workspaceId,
    notificationIntentId: intentId,
    outboxEventId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  } as const;
  await writeNotificationRecords(client, input, {
    intentId,
    terminalEventSequence: terminalEvent.sequence,
    contextJson,
    contextChecksum,
    outboxEventId,
    payload,
    pins: {
      destinationId: input.destinationId,
      destinationConfigVersion: input.destinationConfigVersion,
      sideEffectClass: input.sideEffectClass,
    },
  });
}

async function readPrimaryFailure(
  client: PoolClient,
  input: Parameters<typeof persistFailureNotificationIntent>[1],
  {
    primary,
    terminalEvent,
  }: Readonly<{
    primary: RunTransitionPlan['checkpoint']['invocations'][number] | undefined;
    terminalEvent: RunTransitionPlan['events'][number];
  }>,
): Promise<Record<string, unknown>> {
  let primaryFailure: Record<string, unknown>;
  if (primary === undefined) {
    if (
      input.plan.checkpoint.runStatus !== 'timed_out' &&
      !(
        input.plan.checkpoint.runStatus === 'failed' &&
        terminalEvent.reasonCode?.startsWith('callable_result_')
      )
    )
      throw new CoordinatorRunStateCorruptError();
    primaryFailure = {
      source: 'run',
      runStatus: input.plan.checkpoint.runStatus,
      safeErrorCode: terminalEvent.reasonCode ?? 'execution.deadline_exceeded',
    };
  } else {
    const [node] = await drizzle(client)
      .select({
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        currentAttemptNumber: nodeRuns.currentAttemptNumber,
        safeErrorCode: nodeRuns.safeErrorCode,
      })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.workspaceId, input.workspaceId),
          eq(nodeRuns.workflowRunId, input.runId),
          eq(nodeRuns.invocationKey, primary.invocationKey),
        ),
      )
      .catch(rethrowQueryFailure);
    if (node?.nodeId !== primary.nodeId || node.status !== primary.status)
      throw new CoordinatorRunStateCorruptError();
    primaryFailure = {
      nodeId: primary.nodeId,
      invocationKey: primary.invocationKey,
      nodeStatus: primary.status,
      attemptNumber: node.currentAttemptNumber ?? primary.attemptNumber,
      safeErrorCode:
        node.safeErrorCode ??
        terminalEvent.reasonCode ??
        `execution.${primary.status}`,
    };
  }

  return primaryFailure;
}

async function writeNotificationRecords(
  client: PoolClient,
  input: Parameters<typeof persistFailureNotificationIntent>[1],
  record: NotificationWrite,
): Promise<void> {
  const db = drizzle(client);
  const inserted = await db
    .insert(runFailureNotificationIntents)
    .select(notificationSource(db, input, record))
    .onConflictDoNothing({
      target: [
        runFailureNotificationIntents.workflowRunId,
        runFailureNotificationIntents.terminalEventSequence,
      ],
    })
    .returning({ id: runFailureNotificationIntents.id })
    .catch(rethrowQueryFailure);
  if (inserted.length !== 1) throw new CoordinatorRunStateCorruptError();
  await db
    .insert(outboxEvents)
    .values({
      id: record.outboxEventId,
      workspaceId: input.workspaceId,
      jobName: 'deliver-run-failure-notification',
      aggregateType: 'run-failure-notification',
      aggregateId: record.intentId,
      payload: sql`${serializeStoredExecutionJsonValue(record.payload)}::jsonb`,
      payloadChecksum: canonicalOutboxPayloadChecksum(record.payload),
    })
    .catch(rethrowQueryFailure);
  await auditFailureNotification(client, {
    workspaceId: input.workspaceId,
    intentId: record.intentId,
    factType: 'intent_created',
    attemptNumber: 0,
    possiblyDispatched: false,
  });
}

type NotificationWrite = Readonly<{
  pins: Readonly<{
    destinationId: string;
    destinationConfigVersion: number;
    sideEffectClass: string;
  }>;
  intentId: string;
  terminalEventSequence: number;
  contextJson: string;
  contextChecksum: string;
  outboxEventId: string;
  payload: Readonly<Record<string, string>>;
}>;

function notificationSource(
  db: Pick<NodePgDatabase, 'select'>,
  input: Pick<
    Parameters<typeof persistFailureNotificationIntent>[1],
    'workspaceId' | 'runId'
  >,
  record: NotificationWrite,
) {
  // INSERT ... SELECT needs the full field order, including the original partial insert's defaults.
  return db
    .select({
      id: sql<string>`${record.intentId}`.as(
        runFailureNotificationIntents.id.name,
      ),
      workspaceId: workflowRuns.workspaceId,
      workflowRunId: workflowRuns.id,
      terminalEventSequence: sql<number>`${record.terminalEventSequence}`.as(
        runFailureNotificationIntents.terminalEventSequence.name,
      ),
      destinationId:
        sql<string>`${workflowRuns.failureNotificationDestinationId}`.as(
          runFailureNotificationIntents.destinationId.name,
        ),
      destinationConfigVersion:
        sql<number>`${workflowRuns.failureNotificationDestinationConfigVersion}`.as(
          runFailureNotificationIntents.destinationConfigVersion.name,
        ),
      sideEffectClass: sql<
        typeof runFailureNotificationIntents.$inferSelect.sideEffectClass
      >`${workflowRuns.failureNotificationSideEffectClass}`.as(
        runFailureNotificationIntents.sideEffectClass.name,
      ),
      context: sql<unknown>`${record.contextJson}::jsonb`.as(
        runFailureNotificationIntents.context.name,
      ),
      contextChecksum: sql<string>`${record.contextChecksum}`.as(
        runFailureNotificationIntents.contextChecksum.name,
      ),
      status: sql<string>`'pending'`.as(
        runFailureNotificationIntents.status.name,
      ),
      deliveryAttempts: sql<number>`0`.as(
        runFailureNotificationIntents.deliveryAttempts.name,
      ),
      dispatchMarkedAt: sql<null>`null`.as(
        runFailureNotificationIntents.dispatchMarkedAt.name,
      ),
      recoveryAt: sql<null>`null`.as(
        runFailureNotificationIntents.recoveryAt.name,
      ),
      nextDeliveryAt: sql<null>`null`.as(
        runFailureNotificationIntents.nextDeliveryAt.name,
      ),
      safeErrorCode: sql<null>`null`.as(
        runFailureNotificationIntents.safeErrorCode.name,
      ),
      possiblyDispatched: sql<null>`null`.as(
        runFailureNotificationIntents.possiblyDispatched.name,
      ),
      providerReference: sql<null>`null`.as(
        runFailureNotificationIntents.providerReference.name,
      ),
      completedAt: sql<null>`null`.as(
        runFailureNotificationIntents.completedAt.name,
      ),
      createdAt: sql<string>`clock_timestamp()`.as(
        runFailureNotificationIntents.createdAt.name,
      ),
      updatedAt: sql<string>`clock_timestamp()`.as(
        runFailureNotificationIntents.updatedAt.name,
      ),
      connectionSecretVersionId:
        workflowRuns.failureNotificationConnectionSecretVersionId,
      deliveryBinding: sql<null>`null`.as(
        runFailureNotificationIntents.deliveryBinding.name,
      ),
      dispatchedConfigVersion: sql<null>`null`.as(
        runFailureNotificationIntents.dispatchedConfigVersion.name,
      ),
      dispatchedSecretVersionId: sql<null>`null`.as(
        runFailureNotificationIntents.dispatchedSecretVersionId.name,
      ),
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, input.workspaceId),
        eq(workflowRuns.id, input.runId),
        eq(
          workflowRuns.failureNotificationDestinationId,
          record.pins.destinationId,
        ),
        eq(
          workflowRuns.failureNotificationDestinationConfigVersion,
          record.pins.destinationConfigVersion,
        ),
        eq(
          workflowRuns.failureNotificationSideEffectClass,
          record.pins.sideEffectClass,
        ),
        isNotNull(workflowRuns.failureNotificationConnectionSecretVersionId),
      ),
    );
}
