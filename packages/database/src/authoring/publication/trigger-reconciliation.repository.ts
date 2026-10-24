import { and, eq, notInArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowTriggers } from '../../schema/authoring/workflows.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { workflowTriggerProjection } from '../../triggers/reconciliation/projection.js';
import type { WorkflowVersionRecord } from '../workflows/representation/contract.js';

const uuidSchema = z.uuid();
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16));

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
    workspaceId: uuidSchema.parse(input.workspaceId),
    outboxEventId: uuidSchema.parse(input.outboxEventId),
    workflowId: uuidSchema.parse(input.workflowId),
    publishedVersionId: uuidSchema.parse(input.publishedVersionId),
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: traceparentSchema.parse(input.traceparent) }),
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
