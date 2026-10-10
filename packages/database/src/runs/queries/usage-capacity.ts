import { workflowRunActiveAdmissions } from '../../schema/runs/admission.js';
import { count as countRows, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';

import { withWorkspaceReadTransaction } from '../../tenant-access/transactions.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';

const inputSchema = z
  .object({
    workspaceId: z.uuid(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
const count = z.number().int().nonnegative();
const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const policyState = z.enum([
  'active',
  'suspended',
  'not_yet_effective',
  'expired',
  'unavailable',
]);
const rowSchema = z
  .object({
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u),
    active_runs: count,
    reserved_active_slots: count,
    queued_runs: count,
    policy_state: policyState,
    version: count.nullable(),
    active_run_limit: count.nullable(),
    queued_run_limit: count.nullable(),
    charged_bytes: decimal,
    byte_limit: decimal,
    charged_count: count,
    artifact_count_limit: count,
    capacity_source: z.enum(['stored', 'default']),
  })
  .strict();

export type WorkspaceUsageCapacityInput = Readonly<z.input<typeof inputSchema>>;
export type WorkspaceUsageCapacityRecord = Readonly<{
  asOf: string;
  execution: Readonly<{
    activeRuns: number;
    reservedActiveSlots: number;
    activeCapacityConsumed: number;
    queuedRuns: number;
    policy: Readonly<{
      state: z.output<typeof policyState>;
      version: number | null;
      activeRunLimit: number | null;
      queuedRunLimit: number | null;
    }>;
  }>;
  artifacts: Readonly<{
    chargedBytes: string;
    byteLimit: string;
    chargedCount: number;
    artifactCountLimit: number;
    source: 'stored' | 'default';
  }>;
}>;

/** ADR 057: current resource capacity, not historical or billable usage. */
export async function readWorkspaceUsageCapacity(
  pool: Pool,
  input: WorkspaceUsageCapacityInput,
): Promise<WorkspaceUsageCapacityRecord> {
  const parsed = inputSchema.parse(input);
  return withWorkspaceReadTransaction(
    pool,
    parsed.workspaceId,
    async (transaction) => {
      const reserved = transaction.db
        .select({ value: countRows() })
        .from(workflowRunActiveAdmissions)
        .where(
          eq(workflowRunActiveAdmissions.workspaceId, transaction.workspaceId),
        );
      const result = await transaction.db.execute(sql`
      select
        to_char(transaction_timestamp() at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as as_of,
        current_runs.active_runs, current_runs.queued_runs,
        (${reserved})::integer as reserved_active_slots,
        case when version.version is null or counter.workspace_id is null then 'unavailable'
          when version.status <> 'active' then 'suspended'
          when version.effective_at > transaction_timestamp() then 'not_yet_effective'
          when version.expires_at <= transaction_timestamp() then 'expired'
          else 'active' end as policy_state,
        version.version, version.active_run_limit, version.queued_run_limit,
        coalesce(capacity.charged_bytes, 0)::text as charged_bytes,
        coalesce(capacity.byte_limit, 1073741824)::text as byte_limit,
        coalesce(capacity.charged_count, 0) as charged_count,
        coalesce(capacity.artifact_count_limit, 1000) as artifact_count_limit,
        case when capacity.workspace_id is null then 'default' else 'stored' end as capacity_source
      from app.workspaces workspace
      cross join (select
        (count(*) filter (where status in ('running','waiting')))::integer as active_runs,
        (count(*) filter (where status='queued'))::integer as queued_runs
        from app.workflow_runs
        where workspace_id=${transaction.workspaceId}
          and status in ('queued','running','waiting')) current_runs
      left join app.workspace_execution_entitlements pointer
        on pointer.workspace_id=${transaction.workspaceId}
      left join app.workspace_execution_entitlement_versions version
        on version.workspace_id=pointer.workspace_id and version.version=pointer.current_version
      left join app.workspace_execution_admission_counters counter
        on counter.workspace_id=${transaction.workspaceId}
      left join app.workspace_artifact_capacity capacity
        on capacity.workspace_id=${transaction.workspaceId}
      where workspace.id=${transaction.workspaceId} and workspace.status='active'
    `);
      if (result.rows[0] === undefined) throw new WorkspaceAccessDeniedError();
      const row = rowSchema.parse(result.rows[0]);
      return Object.freeze({
        asOf: row.as_of,
        execution: Object.freeze({
          activeRuns: row.active_runs,
          reservedActiveSlots: row.reserved_active_slots,
          activeCapacityConsumed: count.parse(
            row.active_runs + row.reserved_active_slots,
          ),
          queuedRuns: row.queued_runs,
          policy: Object.freeze({
            state: row.policy_state,
            version: row.version,
            activeRunLimit: row.active_run_limit,
            queuedRunLimit: row.queued_run_limit,
          }),
        }),
        artifacts: Object.freeze({
          chargedBytes: row.charged_bytes,
          byteLimit: row.byte_limit,
          chargedCount: row.charged_count,
          artifactCountLimit: row.artifact_count_limit,
          source: row.capacity_source,
        }),
      });
    },
    {
      statementTimeoutMillis: 2_000,
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
    },
  );
}
