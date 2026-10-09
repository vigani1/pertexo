import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';
import { inRetentionTransaction } from './retention-transaction.js';

/** Deletes a workspace's stored objects, one page per call. */
export interface WorkspacePurgeObjectStore {
  purgeWorkspacePage(input: {
    readonly maxObjects: number;
    readonly signal?: AbortSignal;
    readonly workspaceId: string;
  }): Promise<{
    readonly completed: boolean;
    readonly deletedCount: number;
  }>;
}

export type WorkspacePurgeProcessResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'started' | 'completed'; workspaceId: string }>
  | Readonly<{
      status: 'progressed';
      workspaceId: string;
      /** The purge step that changed rows, or `objects`. */
      step: string;
    }>;

export interface WorkspacePurgeCoordinator {
  close(): Promise<void>;
  processNext(signal?: AbortSignal): Promise<WorkspacePurgeProcessResult>;
}

/** One bounded change to a purging workspace's rows: `$1` workspace, `$2` limit. */
type PurgeStep = Readonly<{ name: string; statement: string }>;

const deleteRows = (table: string): PurgeStep => ({
  name: table,
  statement: `
    with page as (
      select ctid from app.${table} where workspace_id = $1::uuid limit $2
    )
    delete from app.${table} row using page where row.ctid = page.ctid`,
});

/**
 * Tables a purge keeps after scrubbing what identifies people or requests:
 * the workspace tombstone, audit and usage facts, and transport security facts.
 */
export const PURGE_PRESERVED_TABLES = Object.freeze([
  'workspaces',
  'audit_events',
  'usage_events',
  'transport_security_audit_facts',
]);

/**
 * Everything a purge removes, in dependency order. Each step changes at most
 * one page; a later step runs only once every earlier one has nothing left.
 */
export const PURGE_STEPS: readonly PurgeStep[] = Object.freeze([
  // Workflow organization.
  ...[
    'workflow_favorites',
    'workflow_tag_assignments',
    'workflow_organization_state',
  ].map(deleteRows),
  {
    // Folders nest; leaves go first.
    name: 'workflow_folders',
    statement: `
      with page as (
        select folder.ctid from app.workflow_folders folder
        where folder.workspace_id = $1::uuid
          and not exists (select 1 from app.workflow_folders child
            where child.workspace_id = folder.workspace_id
              and child.parent_id = folder.id)
        limit $2
      )
      delete from app.workflow_folders row using page where row.ctid = page.ctid`,
  },
  deleteRows('workflow_tags'),
  {
    // Payloads are large; a page stays under 1 MiB.
    name: 'workflow_input_case_payloads',
    statement: `
      with page as (
        select case_id, revision,
          sum(canonical_bytes) over (order by case_id, revision) bytes
        from app.workflow_input_case_payloads
        where workspace_id = $1::uuid order by case_id, revision limit least($2::int, 100)
      )
      delete from app.workflow_input_case_payloads payload using page
      where payload.workspace_id = $1::uuid and payload.case_id = page.case_id
        and payload.revision = page.revision and page.bytes <= 1048576`,
  },
  deleteRows('workflow_input_cases'),
  {
    // A node run points at its current attempt; clear it before attempts go.
    name: 'node_run_current_attempts',
    statement: `
      with page as (
        select ctid from app.node_runs
        where workspace_id = $1::uuid and current_attempt_id is not null limit $2
      )
      update app.node_runs row
      set current_attempt_id = null, current_attempt_number = null
      from page where row.ctid = page.ctid`,
  },
  {
    // Audit and usage facts stay as anonymous counts.
    name: 'audit_events_scrubbed',
    statement: `
      with page as (
        select ctid from app.audit_events
        where workspace_id = $1::uuid
          and (actor_user_id is not null or request_id is not null
            or trace_id is not null or metadata <> '{}'::jsonb
            or target_id is distinct from $1::uuid)
        limit $2
      )
      update app.audit_events row
      set actor_user_id = null, request_id = null, trace_id = null,
          metadata = '{}'::jsonb, target_id = $1::uuid
      from page where row.ctid = page.ctid`,
  },
  {
    name: 'usage_events_scrubbed',
    statement: `
      with page as (
        select ctid from app.usage_events
        where workspace_id = $1::uuid
          and (metadata <> '{}'::jsonb or resource_id <> $1::uuid
            or resource_type <> 'workspace-tombstone' or idempotency_key <> id::text)
        limit $2
      )
      update app.usage_events row
      set metadata = '{}'::jsonb, resource_id = $1::uuid,
          resource_type = 'workspace-tombstone', idempotency_key = id::text
      from page where row.ctid = page.ctid`,
  },
  {
    name: 'transport_security_audit_facts_scrubbed',
    statement: `
      with page as (
        select ctid from app.transport_security_audit_facts
        where workspace_id = $1::uuid and (consumer_name <> 'purged' or message_id <> id)
        limit $2
      )
      update app.transport_security_audit_facts row
      set consumer_name = 'purged', message_id = id
      from page where row.ctid = page.ctid`,
  },
  {
    // Workspace creation is idempotent on the created workspace's id.
    name: 'workspace_creation_idempotency_records',
    statement: `
      with page as (
        select ctid from app.workspace_creation_idempotency_records
        where resource_id = $1::uuid limit $2
      )
      delete from app.workspace_creation_idempotency_records row
      using page where row.ctid = page.ctid`,
  },
  {
    // Invitation replacement claims name both workspaces of a replacement.
    name: 'workspace_invitation_binding_replacement_claims',
    statement: `
      with page as (
        select prior_workspace_id, prior_intent_id, prior_binding_digest
        from app.workspace_invitation_binding_replacement_claims
        where (prior_workspace_id = $1::uuid or successor_workspace_id = $1::uuid)
          and app.workspace_invitation_replacement_claim_is_reapable(
            prior_workspace_id, prior_intent_id, prior_binding_digest)
        limit $2
      )
      delete from app.workspace_invitation_binding_replacement_claims claim
      using page
      where claim.prior_workspace_id = page.prior_workspace_id
        and claim.prior_intent_id = page.prior_intent_id
        and claim.prior_binding_digest = page.prior_binding_digest`,
  },
  ...[
    'webhook_trigger_replay_records',
    'webhook_trigger_deliveries',
    'run_failure_notification_audit_facts',
    'run_failure_notification_intents',
    'workflow_run_active_admissions',
    'connection_health_observations',
    'node_attempt_connection_dispatches',
    'operator_unknown_outcome_evidence',
    'operator_run_replay_requests',
    'node_attempts',
    'node_runs',
    'run_events',
    'run_checkpoints',
    'artifact_links',
    'preview_attempts',
    'webhook_endpoint_ingress_limits',
    'trigger_schedule_occurrences',
    'trigger_schedules',
    'webhook_trigger_endpoints',
    'webhook_trigger_secret_versions',
    'workflow_triggers',
    'workflow_failure_notification_policies',
    'workspace_inbox_reads',
    'workspace_inbox_threads',
    'workspace_inbox_events',
    'workflow_concurrency_policies',
    'workflow_trigger_pause_periods',
    'workflow_failure_streaks',
    'workflow_trigger_outcomes',
    'workflow_manual_start_rejections',
    'workflow_runs',
    'workflow_integration_usage',
    'workflow_drafts',
    'connection_events',
    'artifacts',
    'workspace_artifact_capacity',
    'outbox_events',
    'inbox_receipts',
    'idempotency_records',
    'workspace_execution_entitlements',
    'workspace_execution_entitlement_versions',
    'workspace_execution_admission_counters',
    'workspace_lifecycle_operations',
    'workspace_invitation_acceptance_intents',
    'workspace_invitation_delivery_attempts',
    'workspace_invitation_command_receipts',
    'workspace_invitations',
    'workspace_rename_command_receipts',
    'workspace_member_departure_command_receipts',
    'workspace_member_suspension_command_receipts',
    'workspace_ownership_transfer_command_receipts',
    'workspace_member_removal_command_receipts',
    'workspace_member_role_command_receipts',
    'workspace_memberships',
    'workspace_legal_holds',
    'rls_probe_records',
  ].map(deleteRows),
  {
    // Previews chain to their prior preview; leaves go first.
    name: 'preview_runs',
    statement: `
      with page as (
        select preview.ctid from app.preview_runs preview
        where preview.workspace_id = $1::uuid
          and not exists (select 1 from app.preview_runs child
            where child.workspace_id = $1::uuid
              and child.prior_preview_run_id = preview.id)
        limit $2
      )
      delete from app.preview_runs row using page where row.ctid = page.ctid`,
  },
  {
    // A workflow points at its published version; clear it before versions go.
    name: 'workflow_published_versions',
    statement: `
      with page as (
        select ctid from app.workflows
        where workspace_id = $1::uuid and published_version_id is not null limit $2
      )
      update app.workflows row set published_version_id = null
      from page where row.ctid = page.ctid`,
  },
  deleteRows('workflow_versions'),
  deleteRows('workflow_template_origins'),
  deleteRows('workflows'),
  {
    // A connection points at its current secret, so the two go together.
    name: 'connection_secret_versions',
    statement: `
      with page as (
        select version.ctid from app.connection_secret_versions version
        join app.connections connection on connection.id = version.connection_id
        where version.workspace_id = $1::uuid
          and version.id <> connection.current_secret_version_id
        limit $2
      )
      delete from app.connection_secret_versions row using page
      where row.ctid = page.ctid`,
  },
  {
    name: 'connections',
    statement: `
      with page as (
        select id, current_secret_version_id from app.connections
        where workspace_id = $1::uuid limit greatest(1, $2::int / 2)
      ), versions as (
        delete from app.connection_secret_versions version using page
        where version.id = page.current_secret_version_id
        returning version.connection_id
      )
      delete from app.connections connection using page
      where connection.id = page.id
        and exists (select 1 from versions where versions.connection_id = connection.id)`,
  },
  {
    // A destination points at its current version, so the two go together.
    name: 'failure_notification_destination_versions',
    statement: `
      with page as (
        select version.ctid from app.failure_notification_destination_versions version
        join app.failure_notification_destinations destination
          on destination.id = version.destination_id
        where version.workspace_id = $1::uuid
          and version.version <> destination.current_config_version
        limit $2
      )
      delete from app.failure_notification_destination_versions row using page
      where row.ctid = page.ctid`,
  },
  {
    name: 'failure_notification_destinations',
    statement: `
      with page as (
        select id, current_config_version from app.failure_notification_destinations
        where workspace_id = $1::uuid limit greatest(1, $2::int / 2)
      ), versions as (
        delete from app.failure_notification_destination_versions version
        using page where version.destination_id = page.id
          and version.version = page.current_config_version
        returning version.destination_id
      )
      delete from app.failure_notification_destinations destination using page
      where destination.id = page.id
        and exists (select 1 from versions
          where versions.destination_id = destination.id)`,
  },
]);

const optionsSchema = z
  .object({
    lockTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    objectPageSize: z.number().int().min(1).max(1_000).default(500),
    objectTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    pageSize: z.number().int().min(1).max(1_000).default(500),
    statementTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
  })
  .strict();

export type WorkspacePurgeOptions = z.input<typeof optionsSchema>;

const candidateSchema = z.object({
  id: z.uuid(),
  status: z.enum(['pending_deletion', 'purging']),
});

/** Fails if a workspace table still holds the purged workspace's rows. */
async function assertNothingLeft(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  const tables = await client.query<{ name: string }>(
    `select distinct table_class.relname as name
     from pg_attribute attribute
     join pg_class table_class on table_class.oid = attribute.attrelid
     join pg_namespace namespace on namespace.oid = table_class.relnamespace
     where namespace.nspname = 'app' and table_class.relkind = 'r'
       and attribute.attname = 'workspace_id' and not attribute.attisdropped
       and not table_class.relname = any($1::text[])
     order by 1`,
    [PURGE_PRESERVED_TABLES],
  );
  for (const { name } of tables.rows) {
    const left = await client.query(
      `select 1 from app.${name} where workspace_id = $1 limit 1`,
      [workspaceId],
    );
    if (left.rowCount !== 0)
      throw new Error(`Workspace purge left rows in ${name}`);
  }
}

/**
 * Purges workspaces whose recovery period has ended. Each call does one
 * bounded unit of work for one workspace: it starts a purge, removes one
 * page of rows or stored objects, or finishes the purge by leaving a
 * tombstone. Any number of workers can call it; each takes a different
 * workspace while it changes rows.
 */
export function createWorkspacePurgeCoordinator(
  config: DatabaseConfig,
  objectStore: WorkspacePurgeObjectStore,
  inputOptions: WorkspacePurgeOptions = {},
  runtime?: DatabaseRuntime,
): WorkspacePurgeCoordinator {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  const transaction = <T>(
    signal: AbortSignal | undefined,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> => inRetentionTransaction(pool, options, signal, work);

  const purgeRows = (
    signal: AbortSignal | undefined,
  ): Promise<WorkspacePurgeProcessResult | Readonly<{ rowsPurged: string }>> =>
    transaction(signal, async (client) => {
      const candidates = await client.query(
        `select id, status from app.workspaces
         where (status = 'pending_deletion' and purge_after <= clock_timestamp())
            or status = 'purging'
         order by purge_after, id limit 1 for update skip locked`,
      );
      if (candidates.rows[0] === undefined) return { status: 'idle' as const };
      const workspace = candidateSchema.parse(candidates.rows[0]);
      if (workspace.status === 'pending_deletion') {
        await client.query(
          `update app.workspaces set status = 'purging', updated_at = clock_timestamp()
           where id = $1`,
          [workspace.id],
        );
        return { status: 'started' as const, workspaceId: workspace.id };
      }
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspace.id,
      ]);
      for (const step of PURGE_STEPS) {
        const changed = await client.query(step.statement, [
          workspace.id,
          options.pageSize,
        ]);
        if ((changed.rowCount ?? 0) > 0)
          return {
            status: 'progressed' as const,
            workspaceId: workspace.id,
            step: step.name,
          };
      }
      return { rowsPurged: workspace.id };
    });

  const finish = (
    workspaceId: string,
    signal: AbortSignal | undefined,
  ): Promise<WorkspacePurgeProcessResult> =>
    transaction(signal, async (client) => {
      const locked = await client.query(
        `select 1 from app.workspaces where id = $1 and status = 'purging'
         for update skip locked`,
        [workspaceId],
      );
      // Another worker is on it, or already finished it.
      if (locked.rowCount !== 1) return { status: 'idle' as const };
      await assertNothingLeft(client, workspaceId);
      await client.query(
        `update app.workspaces
         set status = 'deleted', name = 'Deleted workspace',
             slug = 'deleted-' || id::text, created_by = null,
             deletion_requested_by = null, deletion_reason = 'purged',
             updated_at = clock_timestamp()
         where id = $1`,
        [workspaceId],
      );
      return { status: 'completed' as const, workspaceId };
    });

  return Object.freeze({
    close: () => lease.close(),
    processNext: async (signal?: AbortSignal) => {
      const rows = await purgeRows(signal);
      if (!('rowsPurged' in rows)) return rows;
      const workspaceId = rows.rowsPurged;
      // Stored objects go after rows and outside any transaction.
      const objects = await objectStore.purgeWorkspacePage({
        maxObjects: options.objectPageSize,
        signal: AbortSignal.any([
          ...(signal === undefined ? [] : [signal]),
          AbortSignal.timeout(options.objectTimeoutMs),
        ]),
        workspaceId,
      });
      if (!objects.completed)
        return Object.freeze({
          status: 'progressed' as const,
          workspaceId,
          step: 'objects',
        });
      return finish(workspaceId, signal);
    },
  });
}
