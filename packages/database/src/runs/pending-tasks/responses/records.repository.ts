import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { nodeRuns } from '../../../schema/runs/execution.js';
import { workflows } from '../../../schema/authoring/workflows.js';
import { users } from '../../../schema/foundation.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { and, eq, desc, inArray, lt, or, sql } from 'drizzle-orm';
import type { FolderScope } from '../../../tenant-access/resources/contract.js';
import { workflowScopeSql } from '../../../tenant-access/resources/scope.queries.js';
import type { PoolClient } from 'pg';
import type {
  PendingTaskDetail,
  PendingTaskListQuery,
  PendingTaskListResponse,
} from '@pertexo/contracts';
import {
  approvalConfigSchema,
  inputRequestConfigSchema,
  formSubmissionSchema,
  approvalOutputSchema,
  taskContextSchema,
} from '@pertexo/workflow-model';
import { parseStoredExecutionValue } from '../../../platform/stored-execution-value.js';
import type { Role } from '@pertexo/workflow-model';
import { PendingTaskNotFoundError } from './errors.js';
import type { PendingTaskScope } from './contract.js';

import {
  task,
  run,
  pendingTaskAudienceSql,
  pendingTaskBlockedSql,
} from './eligibility.queries.js';
export type TaskRow = Awaited<ReturnType<typeof taskQuery>>[number];
export function projectTask(row: TaskRow): PendingTaskDetail {
  const captured =
    row.kind === 'approval'
      ? {
          kind: 'approval' as const,
          config: approvalConfigSchema.parse(row.config),
        }
      : {
          kind: 'input_request' as const,
          config: inputRequestConfigSchema.parse(row.config),
        };
  const config = captured.config;
  const context = taskContextSchema.parse(row.context);
  // A timed-out task's output is for later steps; the request has no answer.
  const stored =
    row.output_ref === null || row.status === 'expired'
      ? null
      : parseStoredExecutionValue(row.output_ref);
  if (stored !== null && stored.kind !== 'inline')
    throw new Error('Task result is not inline');
  const common = {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    workflowVersionId: row.workflow_version_id,
    runId: row.run_id,
    nodeId: row.node_id,
    nodeRunId: row.node_run_id,
    kind: row.kind,
    iterationPath: row.branch_context.iterationPath ?? [],
    title: config.title,
    details: context.details ?? {},
    instructions: config.instructions,
    audience: config.audience,
    onExpiry: config.onExpiry,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    completedByName: row.decided_by_name,
    canRespond: row.blocked_reason === null,
    blockedReason: row.blocked_reason,
  };
  if (captured.kind === 'input_request')
    return {
      ...common,
      kind: 'input_request',
      fields: captured.config.fields,
      prefill: context.prefill ?? {},
      output:
        stored?.kind === 'inline'
          ? formSubmissionSchema.parse(stored.value)
          : null,
    };
  const output =
    stored?.kind === 'inline' ? approvalOutputSchema.parse(stored.value) : null;
  return {
    ...common,
    kind: 'approval',
    completedByName: output?.decidedByName ?? row.decided_by_name,
    output,
  };
}
export async function readTaskRow(
  client: PoolClient,
  input: PendingTaskScope & Readonly<{ taskId: string }>,
  {
    role,
    resources,
    locking = false,
  }: Readonly<{
    role: Role;
    resources: FolderScope;
    locking?: boolean | undefined;
  }>,
): Promise<TaskRow> {
  const query = taskQuery(client, { actorId: input.actorId, role }).where(
    and(
      eq(task.workspaceId, input.workspaceId),
      eq(task.id, input.taskId),
      workflowScopeSql(resources, sql`${run.workflowId}`),
    ),
  );
  const [row] = await (
    locking ? query.for('update', { of: task }) : query
  ).catch(rethrowQueryFailure);
  if (row === undefined)
    throw new PendingTaskNotFoundError('Task is not visible.');
  return row;
}
export async function listTasks(
  client: PoolClient,
  input: PendingTaskScope & PendingTaskListQuery,
  role: Role,
  resources: FolderScope,
): Promise<PendingTaskListResponse> {
  const visible = workflowScopeSql(resources, sql`${run.workflowId}`);
  const kind =
    input.kind === undefined || input.kind === 'all'
      ? undefined
      : eq(task.kind, input.kind);
  const audience = pendingTaskAudienceSql(
    sql`${input.actorId}::uuid`,
    sql`${role}::text`,
  );
  const view =
    input.view === 'all'
      ? undefined
      : or(eq(task.decidedBy, input.actorId), audience);
  const status = taskStatusFilter(input.status);
  const rows = await taskQuery(client, { actorId: input.actorId, role })
    .where(
      and(
        eq(task.workspaceId, input.workspaceId),
        visible,
        input.runId === undefined ? undefined : eq(task.runId, input.runId),
        view,
        kind,
        status,
        input.after === undefined ? undefined : lt(task.id, input.after),
      ),
    )
    .orderBy(desc(task.id))
    .limit(51)
    .catch(rethrowQueryFailure);
  const counted = taskQuery(client, { actorId: input.actorId, role })
    .where(
      and(
        eq(task.workspaceId, input.workspaceId),
        visible,
        eq(task.status, 'pending'),
        kind,
        sql`${pendingTaskBlockedSql(sql`${input.actorId}::uuid`, sql`${role}::text`)} is null`,
      ),
    )
    .as('counted_tasks');
  const [count] = await drizzle(client)
    .select({ count: sql<number>`count(*)::int` })
    .from(counted)
    .catch(rethrowQueryFailure);
  const page = rows.slice(0, 50);
  return {
    items: page.map((row) => {
      const {
        instructions: _instructions,
        audience: _audience,
        output: _output,
        workflowVersionId: _version,
        ...summary
      } = projectTask(row);
      if ('fields' in summary) {
        const { fields: _fields, prefill: _prefill, ...item } = summary;
        return item;
      }
      return summary;
    }),
    nextCursor: rows.length > 50 ? (page.at(-1)?.id ?? null) : null,
    pendingCount: count?.count ?? 0,
  };
}

function taskStatusFilter(status: PendingTaskListQuery['status']) {
  if (status === 'pending') return eq(task.status, 'pending');
  if (status === 'resolved') return sql`${task.status}<>'pending'`;
  return undefined;
}
function taskQuery(
  client: PoolClient,
  input: Readonly<{ actorId: string; role: Role }>,
) {
  const node = nodeRuns,
    decider = alias(users, 'decider');
  // The ordinary-task kind/state checks and inner node join guarantee these narrower fields.
  return drizzle(client)
    .select({
      id: task.id,
      workspace_id: task.workspaceId,
      run_id: task.runId,
      workflow_version_id: task.workflowVersionId,
      node_run_id: sql<string>`${task.nodeRunId}`,
      invocation_key: task.invocationKey,
      node_id: node.nodeId,
      branch_context: sql<
        Readonly<{ iterationPath?: PendingTaskDetail['iterationPath'] }>
      >`${node.branchContext}`,
      workflow_id: run.workflowId,
      workflow_name: workflows.name,
      kind: sql<'approval' | 'input_request'>`${task.kind}`,
      config: task.config,
      context: task.context,
      status: sql<PendingTaskDetail['status']>`${task.status}`,
      output_ref: task.outputRef,
      decided_by_name: decider.displayName,
      created_at: task.createdAt,
      expires_at: sql<Date>`${task.expiresAt}`.mapWith(task.expiresAt),
      completed_at: task.completedAt,
      blocked_reason: sql<
        PendingTaskDetail['blockedReason']
      >`${pendingTaskBlockedSql(sql`${input.actorId}::uuid`, sql`${input.role}::text`)}`,
    })
    .from(task)
    .innerJoin(
      run,
      and(
        eq(run.workspaceId, task.workspaceId),
        eq(run.id, task.runId),
        eq(run.workflowVersionId, task.workflowVersionId),
        inArray(task.kind, ['approval', 'input_request']),
      ),
    )
    .innerJoin(
      node,
      and(
        eq(node.workspaceId, task.workspaceId),
        eq(node.workflowRunId, task.runId),
        eq(node.id, task.nodeRunId),
        eq(node.invocationKey, task.invocationKey),
      ),
    )
    .innerJoin(
      workflows,
      and(
        eq(workflows.workspaceId, run.workspaceId),
        eq(workflows.id, run.workflowId),
      ),
    )
    .leftJoin(decider, eq(decider.id, task.decidedBy));
}
