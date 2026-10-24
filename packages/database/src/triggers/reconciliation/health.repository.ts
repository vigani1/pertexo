import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflows,
  workflowTriggers,
} from '../../schema/authoring/workflows.js';
import { webhookTriggerEndpoints as endpoints } from '../../schema/triggers/endpoints.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { WebhookAuthentication } from '@pertexo/contracts';
import type { PoolClient } from 'pg';
import {
  workflowActivationAfterReconciliation,
  type WorkflowTriggerStatus,
} from '@pertexo/workflow-model';

export type WorkflowTriggerHealth = Readonly<{
  id: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  kind: 'webhook' | 'schedule';
  status: WorkflowTriggerStatus;
  healthStatus: 'pending' | 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
  lastErrorCode: string | null;
  endpointReady: boolean;
  authentication?: WebhookAuthentication;
  reconciledAt: Date | null;
}>;

export async function refreshWorkflowActivation(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  { failed = false }: Readonly<{ failed?: boolean | undefined }> = {},
): Promise<void> {
  const db = drizzle(client);
  const authority = await db
    .select({
      lifecycleStatus: workflows.lifecycleStatus,
      publishedVersionId: workflows.publishedVersionId,
    })
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const workflow = authority[0];
  if (workflow === undefined) return;
  const triggers = await db
    .select({ status: workflowTriggers.status })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, workspaceId),
        eq(workflowTriggers.workflowId, workflowId),
        eq(
          workflowTriggers.workflowVersionId,
          sql`${workflow.publishedVersionId}`,
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  const activation = workflowActivationAfterReconciliation({
    lifecycleStatus: workflow.lifecycleStatus,
    hasPublishedVersion: workflow.publishedVersionId !== null,
    triggerStatuses: triggers.map(({ status }) => status),
    failed,
  });
  await db
    .update(workflows)
    .set({ activationStatus: activation, updatedAt: sql`clock_timestamp()` })
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
}

export async function readHealth(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
): Promise<readonly WorkflowTriggerHealth[]> {
  const db = drizzle(client);
  const published = db
    .select({ id: workflows.publishedVersionId })
    .from(workflows)
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    );
  const rows = await db
    .select({
      id: workflowTriggers.id,
      workflowId: workflowTriggers.workflowId,
      workflowVersionId: workflowTriggers.workflowVersionId,
      nodeId: workflowTriggers.nodeId,
      kind: workflowTriggers.kind,
      status: workflowTriggers.status,
      healthStatus: workflowTriggers.healthStatus,
      lastErrorCode: workflowTriggers.lastErrorCode,
      reconciledAt: workflowTriggers.reconciledAt,
      authentication: endpoints.authentication,
      endpointReady: sql<boolean>`(${endpoints.id} is not null and ${endpoints.status}='active')`,
    })
    .from(workflowTriggers)
    .leftJoin(
      endpoints,
      and(
        eq(endpoints.workspaceId, workflowTriggers.workspaceId),
        eq(endpoints.triggerId, workflowTriggers.id),
      ),
    )
    .where(
      and(
        eq(workflowTriggers.workspaceId, workspaceId),
        eq(workflowTriggers.workflowId, workflowId),
        eq(workflowTriggers.workflowVersionId, published),
      ),
    )
    .orderBy(workflowTriggers.nodeId)
    .catch(rethrowQueryFailure);
  return Object.freeze(
    rows.map(({ authentication, ...row }) =>
      Object.freeze({
        ...row,
        ...(row.kind === 'webhook'
          ? {
              authentication:
                authentication ??
                ({
                  mode: 'signed',
                  allowedOrigins: [],
                } satisfies WebhookAuthentication),
            }
          : {}),
      }),
    ),
  );
}
