import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { workflows } from '../../../schema/authoring/workflows.js';
import { auditEvents } from '../../../schema/foundation.js';
import { outboxEvents } from '../../../schema/transport.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';

import { canonicalOutboxPayloadChecksum } from '../../../outbox/events.repository.js';
import { z } from 'zod';
import { planWorkflowLifecycleCommand } from '@pertexo/workflow-model';

import {
  claimWorkflowCommand,
  completeWorkflowCommand,
  type WorkflowCommand,
} from '../receipts.repository.js';
import {
  WorkflowLifecycleRevisionConflictError,
  WorkflowNotFoundError,
} from '../errors.js';
import type {
  TransitionWorkflowLifecycleInput,
  TransitionWorkflowLifecycleResult,
  WorkflowAuthoringDatabase,
} from '../contract.js';
import type { WorkflowAuthoringWriteContext } from '../context.js';
import { workflowProjection } from '../representation/records.queries.js';
import { reconcileWorkflowTriggersPayload } from '../../publication/trigger-reconciliation.repository.js';

const uuidSchema = z.uuid();
const commandSchema = z.enum(['archive', 'restore']);
const lifecycleRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const requestIdSchema = z.string().max(128);

type WorkflowLifecycleStore = Pick<
  WorkflowAuthoringDatabase,
  'transitionWorkflowLifecycle'
>;

type WorkflowLifecycleContext = Pick<
  WorkflowAuthoringWriteContext,
  'requireAuthor' | 'transact'
>;

async function transitionWorkflowLifecycle(
  context: WorkflowLifecycleContext,
  input: TransitionWorkflowLifecycleInput,
): Promise<TransitionWorkflowLifecycleResult> {
  const command = commandSchema.parse(input.command);
  const workspaceId = uuidSchema.parse(input.workspaceId);
  const workflowId = uuidSchema.parse(input.workflowId);
  const actorId = uuidSchema.parse(input.actorId);
  const expectedLifecycleRevision = lifecycleRevisionSchema.parse(
    input.expectedLifecycleRevision,
  );
  const requestId =
    input.requestId === undefined
      ? undefined
      : requestIdSchema.parse(input.requestId);
  const traceId =
    input.traceId === undefined
      ? undefined
      : requestIdSchema.parse(input.traceId);

  return context.transact(workspaceId, actorId, async (client) => {
    await context.requireAuthor(client, workspaceId, {
      actorId,
      workflowId,
    });
    const claim: WorkflowCommand = {
      workspaceId,
      workflowId,
      actorId,
      operation: `workflow.${command}`,
      idempotencyKey: input.idempotencyKey,
      request: { expectedLifecycleRevision },
    };
    const replay = await claimWorkflowCommand(client, claim);
    if (replay !== null) {
      const visible = await drizzle(client)
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.workspaceId, workspaceId),
            eq(workflows.id, workflowId),
          ),
        )
        .for('share')
        .catch(rethrowQueryFailure);
      if (visible.length !== 1)
        throw new WorkflowNotFoundError('Workflow is not visible');
      return Object.freeze({ replayed: true, workflow: replay });
    }

    const [currentRow] = await drizzle(client)
      .select(workflowProjection)
      .from(workflows)
      .where(
        and(
          eq(workflows.workspaceId, workspaceId),
          eq(workflows.id, workflowId),
        ),
      )
      .for('update')
      .catch(rethrowQueryFailure);
    if (currentRow === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const current = Object.freeze(currentRow);
    if (current.lifecycleRevision !== expectedLifecycleRevision)
      throw new WorkflowLifecycleRevisionConflictError(
        current.lifecycleRevision,
      );

    const decision = planWorkflowLifecycleCommand({
      activationStatus: current.activationStatus,
      command,
      hasPublishedVersion: current.publishedVersionId !== null,
      lifecycleStatus: current.lifecycleStatus,
    });
    let workflow = current;
    if (decision.changed) {
      const [updatedRow] = await drizzle(client)
        .update(workflows)
        .set({
          lifecycleStatus: decision.lifecycleStatus,
          activationStatus: decision.activationStatus,
          lifecycleRevision: sql`${workflows.lifecycleRevision}+1`,
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(
          and(
            eq(workflows.workspaceId, workspaceId),
            eq(workflows.id, workflowId),
            eq(workflows.lifecycleRevision, expectedLifecycleRevision),
          ),
        )
        .returning(workflowProjection)
        .catch(rethrowQueryFailure);
      if (updatedRow === undefined)
        throw new WorkflowLifecycleRevisionConflictError(
          current.lifecycleRevision,
        );
      workflow = Object.freeze(updatedRow);

      if (decision.reconcileTriggers) {
        await enqueueLifecycleReconciliation(client, {
          workspaceId,
          workflowId,
          publishedVersionId: current.publishedVersionId,
          traceparent: input.traceparent,
        });
      }

      await drizzle(client)
        .insert(auditEvents)
        .values({
          id: generatePersistedId(),
          workspaceId,
          actorUserId: actorId,
          action:
            command === 'archive' ? 'workflow.archived' : 'workflow.restored',
          targetType: 'workflow',
          targetId: workflowId,
          requestId: requestId ?? null,
          traceId: traceId ?? null,
          metadata: {
            activationStatus: workflow.activationStatus,
            lifecycleRevision: workflow.lifecycleRevision,
            lifecycleStatus: workflow.lifecycleStatus,
            previousActivationStatus: current.activationStatus,
            previousLifecycleRevision: current.lifecycleRevision,
            previousLifecycleStatus: current.lifecycleStatus,
            publishedVersionId: current.publishedVersionId,
          },
        })
        .catch(rethrowQueryFailure);
    }

    await completeWorkflowCommand(client, claim, workflow);
    return Object.freeze({ replayed: false, workflow });
  });
}

export function createWorkflowAuthoringLifecycleStore(
  context: WorkflowLifecycleContext,
): WorkflowLifecycleStore {
  return Object.freeze({
    transitionWorkflowLifecycle: (input) =>
      transitionWorkflowLifecycle(context, input),
  });
}

async function enqueueLifecycleReconciliation(
  client: PoolClient,
  {
    workspaceId,
    workflowId,
    publishedVersionId,
    traceparent,
  }: Readonly<{
    workspaceId: string;
    workflowId: string;
    publishedVersionId: string | null;
    traceparent: string | undefined;
  }>,
) {
  if (publishedVersionId === null)
    throw new Error(
      'Workflow lifecycle reconciliation requires a published version',
    );
  const outboxEventId = generatePersistedId();
  const payload = reconcileWorkflowTriggersPayload({
    outboxEventId,
    publishedVersionId: publishedVersionId,
    ...(traceparent === undefined ? {} : { traceparent: traceparent }),
    workflowId,
    workspaceId,
  });
  await drizzle(client)
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId,
      jobName: 'reconcile-workflow-triggers',
      aggregateType: 'workflow',
      aggregateId: workflowId,
      payload: sql`${JSON.stringify(payload)}::jsonb`,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    })
    .catch(rethrowQueryFailure);
}
