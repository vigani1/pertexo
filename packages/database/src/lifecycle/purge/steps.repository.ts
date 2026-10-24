import { purgeDirectoryMemberships } from '../identity/directory.repository.js';
import { reapInvitationReplacementClaims } from '../invitations/claims.repository.js';

import type { PurgeStep } from './contract.js';

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
  deleteRows('workflow_folder_grants'),
  deleteRows('connection_shares'),
  {
    name: 'personal_notice_mail',
    statement: `with page as (select delivery.id from app.system_mail_deliveries delivery join app.notice_mail_batches batch on batch.id=delivery.id where batch.workspace_id=$1 limit $2) delete from app.system_mail_deliveries delivery using page where delivery.id=page.id`,
  },
  ...[
    'notice_mail_items',
    'notice_mail_batches',
    'notice_subscriptions',
    'notice_preferences',
    'notice_workspace_settings',
  ].map(deleteRows),
  { name: 'auth_directory_memberships', run: purgeDirectoryMemberships },
  deleteRows('auth_directory_group_mappings'),
  {
    name: 'identity_federation_attempts',
    statement: `with page as (
      select attempt.id from app.auth_federation_attempts attempt
      join app.auth_organizations organization on organization.id=attempt.organization_id
      where organization.control_workspace_id=$1 order by attempt.id limit $2
    ) delete from app.auth_federation_attempts attempt using page where attempt.id=page.id`,
  },
  {
    name: 'identity_provider_sessions',
    statement: `with page as (
      select session.id from app.auth_sessions session
      join app.auth_providers provider on provider.id=session.federation_provider_id
      join app.auth_organizations organization on organization.id=provider.organization_id
      where organization.control_workspace_id=$1 order by session.id limit $2
    ) delete from app.auth_sessions session using page where session.id=page.id`,
  },
  {
    name: 'identity_provider_accounts',
    statement: `with page as (
      select account.id from app.auth_accounts account
      join app.auth_providers provider on provider.id::text=account.provider_id
      join app.auth_organizations organization on organization.id=provider.organization_id
      where organization.control_workspace_id=$1 order by account.id limit $2
    ) delete from app.auth_accounts account using page where account.id=page.id`,
  },
  {
    name: 'identity_organization',
    statement: `with page as (
      select id from app.auth_organizations where control_workspace_id=$1 limit $2
    ) delete from app.auth_organizations organization using page where organization.id=page.id`,
  },
  deleteRows('auth_organization_workspaces'),
  deleteRows('api_tokens'),
  deleteRows('workflow_forms'),
  deleteRows('pending_run_tasks'),
  deleteRows('workflow_publication_requests'),
  deleteRows('workspace_promotion_targets'),
  deleteRows('run_error_workflow_intents'),
  deleteRows('workflow_error_policies'),
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
  deleteRows('webhook_test_events'),
  deleteRows('workflow_step_samples'),
  deleteRows('webhook_run_responses'),
  deleteRows('workflow_run_values'),
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
    name: 'workspace_invitation_binding_replacement_claims',
    run: (client, workspaceId, pageSize) =>
      reapInvitationReplacementClaims(client, pageSize, workspaceId),
  },
  ...[
    'workflow_presence_leases',
    'workflow_comment_mentions',
    'workflow_comments',
    'workflow_comment_threads',
    'data_table_write_receipts',
    'workspace_data_table_rows',
    'workspace_data_tables',
    'workspace_data_table_quotas',
    'webhook_trigger_replay_records',
    'webhook_trigger_deliveries',
    'trigger_coordinated_events',
    'trigger_event_windows',
    'run_failure_notification_audit_facts',
    'run_failure_notification_intents',
    'workflow_run_active_admissions',
    'workflow_calls',
    'connection_health_observations',
    'node_attempt_connection_dispatches',
    'operator_unknown_outcome_evidence',
    'operator_run_replay_requests',
    'operator_commands',
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
    'workflow_test_suite_cases',
    'workflow_test_suites',
    'workspace_variables',
    'workspace_inbox_reads',
    'workspace_inbox_threads',
    'workspace_inbox_events',
    'workflow_concurrency_policies',
    'workflow_trigger_pause_periods',
    'workflow_failure_streaks',
    'workflow_trigger_outcomes',
    'workflow_manual_start_rejections',
    'workflow_test_snapshots',
    'workflow_runs',
    'workflow_integration_usage',
    'workflow_version_promotions',
    'workflow_promotion_origins',
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
    'workspace_invitations',
    'workspace_memberships',
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
  deleteRows('workspace_variable_set_revisions'),
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
  deleteRows('workflow_version_dependencies'),
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
