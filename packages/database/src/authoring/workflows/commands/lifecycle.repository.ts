import { appendAuditFact } from '../../../governance/audit/events.repository.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { workflows } from '../../../schema/authoring/workflows.js';
import { outboxEvents } from '../../../schema/transport.js';

import { planWorkflowLifecycleCommand } from '@pertexo/workflow-model';
import { canonicalOutboxPayloadChecksum } from '../../../outbox/events.repository.js';

import { reconcileWorkflowTriggersPayload } from '../../publication/trigger-reconciliation.repository.js';
import type { WorkflowAuthoringWriteContext } from '../context.js';
import type {
  TransitionWorkflowLifecycleInput,
  TransitionWorkflowLifecycleResult,
  WorkflowAuthoringDatabase,
} from '../contract.js';
import {
  WorkflowLifecycleRevisionConflictError,
  WorkflowNotFoundError,
} from '../errors.js';
import {
  claimWorkflowCommand,
  completeWorkflowCommand,
  type WorkflowCommand,
} from '../receipts.repository.js';
import { workflowProjection } from '../representation/records.queries.js';

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
  const command = input.command;
  const workspaceId = input.workspaceId;
  const workflowId = input.workflowId;
  const actorId = input.actorId;
  const expectedLifecycleRevision = input.expectedLifecycleRevision;
  const requestId = input.requestId;
  const traceId = input.traceId;

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

      await appendAuditFact(client, {
        workspaceId,
        actorId: actorId,
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
      });
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
