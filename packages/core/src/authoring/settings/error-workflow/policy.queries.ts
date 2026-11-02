import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { workflows, workflowErrorPolicies } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { WorkflowErrorSettings } from '@pertexo/contracts';
import type { FolderScope } from '../../../shared/contract.js';
import { workflowScopeSql } from '../../../shared/scope.queries.js';
export async function readPolicy(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  access: FolderScope,
): Promise<WorkflowErrorSettings> {
  const target = alias(workflows, 'target'),
    policy = workflowErrorPolicies;
  const visible = workflowScopeSql(access, sql`${target.id}`);
  const [found] = await drizzle(client)
    .select({
      targetWorkflowId: policy.targetWorkflowId,
      revision: policy.revision,
      targetWorkflowName: sql<
        string | null
      >`case when ${visible} then ${target.name} else null end`,
    })
    .from(policy)
    .leftJoin(
      target,
      and(
        eq(target.workspaceId, policy.workspaceId),
        eq(target.id, policy.targetWorkflowId),
      ),
    )
    .where(
      and(
        eq(policy.workspaceId, workspaceId),
        eq(policy.workflowId, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return {
    targetWorkflowId: found?.targetWorkflowId ?? null,
    revision: found?.revision ?? 1,
    targetWorkflowName: found?.targetWorkflowName ?? null,
  };
}
