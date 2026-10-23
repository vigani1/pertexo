import type { PoolClient } from 'pg';
import type { WorkspaceCapacityLimit } from '@pertexo/contracts';

const ratio = { numerator: 4, denominator: 5 } as const;
export const CAPACITY_LIMIT_LABELS: Readonly<
  Record<WorkspaceCapacityLimit, string>
> = {
  active: 'Active runs',
  queue: 'Queued runs',
  artifact_bytes: 'File storage',
  artifact_count: 'File count',
};

// Expressions come only from this module's metric dictionary, never request data.
function approaching(used: string, limit: string, available = 'true'): string {
  return `coalesce((${available}) AND (${limit})>0 AND (${used})::numeric*${String(ratio.denominator)}>=(${limit})::numeric*${String(ratio.numerator)},false)`;
}
const effective = `counter.workspace_id is not null and entitlement.status='active' and entitlement.effective_at<=statement_timestamp() and (entitlement.expires_at is null or entitlement.expires_at>statement_timestamp())`;
const joins = `left join app.workspace_execution_admission_counters counter on counter.workspace_id=workspace.id
 left join app.workspace_execution_entitlements pointer on pointer.workspace_id=workspace.id
 left join app.workspace_execution_entitlement_versions entitlement on entitlement.workspace_id=pointer.workspace_id and entitlement.version=pointer.current_version
 left join app.workspace_artifact_capacity capacity on capacity.workspace_id=workspace.id`;
function metrics(active: string, queued: string) {
  return [
    ['active', approaching(active, 'entitlement.active_run_limit', effective)],
    ['queue', approaching(queued, 'entitlement.queued_run_limit', effective)],
    [
      'artifact_bytes',
      approaching('capacity.charged_bytes', 'capacity.byte_limit'),
    ],
    [
      'artifact_count',
      approaching('capacity.charged_count', 'capacity.artifact_count_limit'),
    ],
  ] as const;
}

// Maintenance discovers candidates without installing one tenant's context globally.
// Current facts below use the scoped capacity function and its existing grants.
export const CAPACITY_WARNING_CANDIDATES_SQL = `select workspace.id workspace_id,metric.capacity_limit
 from app.workspaces workspace
 ${joins}
 left join lateral (
   select count(*)::integer held from app.workflow_run_active_admissions admission
   join app.workflow_runs run on run.workspace_id=admission.workspace_id and run.id=admission.workflow_run_id
   where admission.workspace_id=workspace.id and run.human_wait_started_at is null and run.status not in ('running','waiting')
 ) reserved on true
 cross join lateral (values ${metrics(
   'counter.active_runs+reserved.held',
   'counter.queued_runs',
 )
   .map(([key, condition]) => `('${key}'::varchar,${condition})`)
   .join(',')}) metric(capacity_limit,approaching)
 where workspace.status='active' and metric.approaching`;

export async function readCapacityWarning(
  client: PoolClient,
  workspaceId: string,
  key: WorkspaceCapacityLimit,
): Promise<boolean> {
  const found = await client.query<Record<WorkspaceCapacityLimit, boolean>>(
    `select ${metrics(
      'counts.active_runs+counts.reserved_active_slots',
      'counts.queued_runs',
    )
      .map(([name, condition]) => `${condition} ${name}`)
      .join(',')}
 from app.workspaces workspace cross join app.workflow_run_slot_counts(workspace.id) counts ${joins}
 where workspace.id=$1 and workspace.status='active'`,
    [workspaceId],
  );
  return found.rows[0]?.[key] ?? false;
}
