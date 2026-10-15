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
} from '@pertexo/workflow-model';
import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import type { Role } from '../../tenant-access/policy.js';
import { PendingTaskNotFoundError, type PendingTaskScope } from './contract.js';

// One eligibility predicate serves discovery, detail and the locked command.
const audience = `((task.config->'audience'->'roles') ? $3::text OR (task.config->'audience'->'memberIds') ? $2::text)`;
const blocked = `case when task.status='expired' then 'expired' when task.status <> 'pending' then 'resolved'
  when run.status not in ('queued','running','waiting') or run.cancel_requested_at is not null or run.deadline_at<=clock_timestamp() then 'run_closed'
  when task.expires_at <= clock_timestamp() then 'expired'
  when task.kind='approval' and run.started_by=$2::uuid then 'starter'
  when not ${audience} then 'audience' else null end`;
export function pendingTaskBlockedSql(
  actorParameter: string,
  roleParameter: string,
): string {
  return blocked
    .replaceAll('$2', actorParameter)
    .replaceAll('$3', roleParameter);
}
const columns = `task.*,node.node_id,run.workflow_id,workflow.name workflow_name,
  decider.display_name decided_by_name,node.branch_context,${blocked} blocked_reason`;
const from = `from app.pending_run_tasks task join app.workflow_runs run
  on run.workspace_id=task.workspace_id and run.id=task.run_id and run.workflow_version_id=task.workflow_version_id
  join app.node_runs node on node.workspace_id=task.workspace_id and node.workflow_run_id=task.run_id
    and node.id=task.node_run_id and node.invocation_key=task.invocation_key
  join app.workflows workflow on workflow.workspace_id=run.workspace_id and workflow.id=run.workflow_id
  left join app.users decider on decider.id=task.decided_by`;
export type TaskRow = Readonly<{
  id: string;
  workspace_id: string;
  run_id: string;
  workflow_version_id: string;
  node_run_id: string;
  invocation_key: string;
  node_id: string;
  branch_context: Readonly<{
    iterationPath?: PendingTaskDetail['iterationPath'];
  }>;
  workflow_id: string;
  workflow_name: string;
  kind: 'approval' | 'input_request';
  config: unknown;
  status: PendingTaskDetail['status'];
  output_ref: unknown;
  decided_by_name: string | null;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  blocked_reason: PendingTaskDetail['blockedReason'];
}>;
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
  const stored =
    row.output_ref === null ? null : parseStoredExecutionValue(row.output_ref);
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
    instructions: config.instructions,
    audience: config.audience,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    completedByName: row.decided_by_name,
    canRespond: row.blocked_reason === null,
    blockedReason: row.blocked_reason,
  };
  return captured.kind === 'input_request'
    ? {
        ...common,
        kind: 'input_request',
        fields: captured.config.fields,
        output:
          stored?.kind === 'inline'
            ? formSubmissionSchema.parse(stored.value)
            : null,
      }
    : {
        ...common,
        kind: 'approval',
        output:
          stored?.kind === 'inline'
            ? approvalOutputSchema.parse(stored.value)
            : null,
      };
}
export async function readTaskRow(
  client: PoolClient,
  input: PendingTaskScope & Readonly<{ taskId: string }>,
  role: Role,
  locking = false,
): Promise<TaskRow> {
  const result = await client.query<TaskRow>(
    `select ${columns} ${from} where task.workspace_id=$1 and task.id=$4 ${locking ? 'for update of task' : ''}`,
    [input.workspaceId, input.actorId, role, input.taskId],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new PendingTaskNotFoundError('Task is not visible.');
  return row;
}
export async function listTasks(
  client: PoolClient,
  input: PendingTaskScope & PendingTaskListQuery,
  role: Role,
): Promise<PendingTaskListResponse> {
  const params = [
    input.workspaceId,
    input.actorId,
    role,
    input.runId ?? null,
    input.view,
    input.status,
    input.after ?? null,
    input.kind ?? 'all',
  ];
  const candidates = `task.workspace_id=$1 and ($4::uuid is null or task.run_id=$4)
    and ($5='all' or task.decided_by=$2::uuid or ((task.kind<>'approval' or run.started_by is distinct from $2::uuid) and ${audience}))
    and ($8='all' or task.kind=$8)
    and ($6='all' or ($6='pending' and task.status='pending') or ($6='resolved' and task.status<>'pending'))`;
  const rows = await client.query<TaskRow>(
    `select ${columns} ${from} where ${candidates} and ($7::uuid is null or task.id<$7) order by task.id desc limit 51`,
    params,
  );
  const count = await client.query<{ count: number }>(
    `select count(*)::int count ${from} where task.workspace_id=$1 and task.status='pending' and ($4='all' or task.kind=$4) and (${blocked}) is null`,
    [...params.slice(0, 3), input.kind ?? 'all'],
  );
  const page = rows.rows.slice(0, 50);
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
        const { fields: _fields, ...item } = summary;
        return item;
      }
      return summary;
    }),
    nextCursor: rows.rows.length > 50 ? (page.at(-1)?.id ?? null) : null,
    pendingCount: count.rows[0]?.count ?? 0,
  };
}
