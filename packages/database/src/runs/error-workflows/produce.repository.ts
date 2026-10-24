import { workflows } from '../../schema/authoring/workflows.js';
import { workflowErrorPolicies } from '../../schema/authoring/error-workflow.js';
import { workflowRuns } from '../../schema/runs/execution.js';
import { runErrorWorkflowIntents } from '../../schema/runs/completion/error-workflow.js';
import { outboxEvents } from '../../schema/transport.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import type { RunTransitionPlan } from '../advance/plan.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import { errorWorkflowInput, errorWorkflowFailure } from './summary.js';
import { readErrorWorkflowStep } from './step.queries.js';

/** The terminal transition and its unique intent/outbox either all commit or none do. */
export async function persistErrorWorkflowIntent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    workflowId: string;
    workflowVersionId: string;
    cancellationRequested: boolean;
    plan: RunTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  if (
    input.cancellationRequested ||
    !input.plan.events.some((event) =>
      ['run.failed', 'run.timed_out', 'run.outcome_unknown'].includes(
        event.name,
      ),
    )
  )
    return;
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
  if (row === undefined) return;
  const failed = errorWorkflowFailure(input.plan);
  const context = errorWorkflowInput({
    ...input,
    workflowName: row.workflow_name,
    ...(failed === undefined
      ? {}
      : {
          step: await readErrorWorkflowStep(client, {
            ...input,
            invocationKey: failed.invocationKey,
            nodeId: failed.nodeId,
          }),
        }),
  });
  if (row.target_version_id === null) {
    await drizzle(client)
      .insert(runErrorWorkflowIntents)
      .values({
        workspaceId: input.workspaceId,
        sourceRunId: input.runId,
        targetWorkflowId: row.target_workflow_id,
        targetVersionId: null,
        context,
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
    return;
  }
  const outboxEventId = generatePersistedId();
  const inserted = await drizzle(client)
    .insert(runErrorWorkflowIntents)
    .values({
      workspaceId: input.workspaceId,
      sourceRunId: input.runId,
      targetWorkflowId: row.target_workflow_id,
      targetVersionId: row.target_version_id,
      context,
      outboxEventId,
    })
    .onConflictDoNothing({
      target: [
        runErrorWorkflowIntents.workspaceId,
        runErrorWorkflowIntents.sourceRunId,
      ],
    })
    .returning({ id: runErrorWorkflowIntents.sourceRunId })
    .catch(rethrowQueryFailure);
  if (inserted.length !== 1) return;
  const payload = {
    workspaceId: input.workspaceId,
    sourceRunId: input.runId,
    outboxEventId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  };
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
