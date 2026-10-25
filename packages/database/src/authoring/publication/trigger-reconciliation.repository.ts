import { and, eq, notInArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { workflowTriggers } from '../../schema/authoring/workflows.js';
import { workflowTriggerProjection } from '../../triggers/reconciliation/projection.js';
import type { WorkflowVersionRecord } from '../workflows/representation/contract.js';

export function reconcileWorkflowTriggersPayload(
  input: Readonly<{
    outboxEventId: string;
    publishedVersionId: string;
    traceparent?: string;
    workflowId: string;
    workspaceId: string;
  }>,
): Record<string, unknown> {
  return Object.freeze({
    workspaceId: input.workspaceId,
    outboxEventId: input.outboxEventId,
    workflowId: input.workflowId,
    publishedVersionId: input.publishedVersionId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  });
}

/** Materializes the desired triggers for one published immutable version. */
export async function persistPublishedWorkflowTriggers(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    version: WorkflowVersionRecord;
  }>,
): Promise<void> {
  const { workflowId, version } = input;
  const triggers = workflowTriggerProjection(version.graphJson);
  const db = drizzle(client);
  const nodeIds = triggers.map(({ nodeId }) => nodeId);
  await db
    .delete(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, input.workspaceId),
        eq(workflowTriggers.workflowVersionId, version.id),
        notInArray(workflowTriggers.nodeId, nodeIds),
      ),
    )
    .catch(rethrowQueryFailure);
  if (triggers.length > 0)
    await db
      .insert(workflowTriggers)
      .values(
        triggers.map((trigger) => ({
          id: generatePersistedId(),
          workspaceId: input.workspaceId,
          workflowId,
          workflowVersionId: version.id,
          nodeId: trigger.nodeId,
          kind: trigger.kind,
          desiredConfig: trigger.config,
          configFingerprint: trigger.configFingerprint,
          status: 'desired' as const,
        })),
      )
      .onConflictDoUpdate({
        target: [workflowTriggers.workflowVersionId, workflowTriggers.nodeId],
        set: {
          desiredConfig: sql`excluded.desired_config`,
          configFingerprint: sql`excluded.config_fingerprint`,
        },
        setWhere: sql`${and(
          eq(workflowTriggers.workspaceId, sql`excluded.workspace_id`),
          eq(workflowTriggers.workflowId, sql`excluded.workflow_id`),
          eq(workflowTriggers.kind, sql`excluded.kind`),
        )}`,
      })
      .catch(rethrowQueryFailure);
}
