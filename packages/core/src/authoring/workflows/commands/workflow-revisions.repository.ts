import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflows } from '@pertexo/database/schema';
import type {
  WorkflowActivationStatus,
  WorkflowLifecycleStatus,
} from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { WorkflowRef } from '../../../shared/workflow-actor.types.js';
import { workflowProjection } from '../representation/workflow-representations.repository.js';

/** Renames an active workflow at its expected name revision; undefined when it moved. */
export async function renameAtRevision(
  client: PoolClient,
  input: WorkflowRef & Readonly<{ name: string; expectedNameRevision: number }>,
) {
  const [row] = await drizzle(client)
    .update(workflows)
    .set({
      name: input.name,
      nameRevision: sql`${workflows.nameRevision}+1`,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
        eq(workflows.nameRevision, input.expectedNameRevision),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .returning(workflowProjection)
    .catch(rethrowQueryFailure);
  return row;
}

/** Writes a lifecycle decision at the expected lifecycle revision; undefined when it moved. */
export async function transitionAtRevision(
  client: PoolClient,
  input: WorkflowRef &
    Readonly<{
      lifecycleStatus: WorkflowLifecycleStatus;
      activationStatus: WorkflowActivationStatus;
      expectedLifecycleRevision: number;
    }>,
) {
  const [row] = await drizzle(client)
    .update(workflows)
    .set({
      lifecycleStatus: input.lifecycleStatus,
      activationStatus: input.activationStatus,
      lifecycleRevision: sql`${workflows.lifecycleRevision}+1`,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
        eq(workflows.lifecycleRevision, input.expectedLifecycleRevision),
      ),
    )
    .returning(workflowProjection)
    .catch(rethrowQueryFailure);
  return row;
}
