import { bindResourcePredicate } from '../../tenant-access/resources/query-scope.js';
import { AUDIT_RETENTION_MIN_DAYS } from '@pertexo/workflow-model';
import { CALLBACK_TASK_RETENTION_RULE } from '../../runs/pending-tasks/callbacks/retention.js';
import { RUN_VALUES_RETENTION_RULE } from '../../runs/values/retention.js';

import { INBOX_RETENTION_RULE } from '../../inbox/retention.repository.js';
import {
  expiredRunSql,
  retainedTestRunSql,
  testRunSql,
  RUN_DETAILS_RETENTION_SQL,
  RUN_SUMMARY_RETENTION_SQL,
} from '../../runs/data-policy.js';
import { VARIABLE_SET_RETENTION_RULE } from '../../variables/retention.repository.js';
import { API_TOKEN_RETENTION_RULE } from '../identity/tokens.repository.js';
import { reapInvitationReplacementClaims } from '../invitations/claims.repository.js';
import {
  CALL_CHILD_REFERENCES_RETENTION_RULE,
  CALL_DETAILS_RETENTION_RULE,
} from '../calls/retention.repository.js';

/**
 * What retention removes and when. Each rule clears or deletes at most one page
 * of rows per call, and one worker at a time runs a given rule. Later rules
 * depend on earlier ones: a run summary is deleted only once its details are
 * gone and no trigger record or replay still refers to it.
 *
 * A rule that deletes rows someone may still change repeats its condition on
 * the deleted row, so a row changed while the delete waited for it is kept.
 */
export const RETENTION_RULES = Object.freeze([
  API_TOKEN_RETENTION_RULE,
  RUN_VALUES_RETENTION_RULE,
  {
    name: 'workflow_presence_leases',
    statement: `with page as(select workspace_id,workflow_id,user_id,tab_id from app.workflow_presence_leases where expires_at<=clock_timestamp() order by expires_at limit $1) delete from app.workflow_presence_leases lease using page where lease.workspace_id=page.workspace_id and lease.workflow_id=page.workflow_id and lease.user_id=page.user_id and lease.tab_id=page.tab_id and lease.expires_at<=clock_timestamp()`,
  },

  {
    name: 'provisioning_credentials',
    statement: `with page as(select id from app.auth_provisioning_credentials where revoked_at<=clock_timestamp()-interval '30 days' order by id limit $1) delete from app.auth_provisioning_credentials credential using page where credential.id=page.id and credential.revoked_at<=clock_timestamp()-interval '30 days'`,
  },
  {
    name: 'publication_requests',
    statement: `with page as(select workspace_id,id from app.workflow_publication_requests where coalesce(decided_at,expires_at)<=clock_timestamp()-interval '30 days' order by coalesce(decided_at,expires_at),id limit $1) delete from app.workflow_publication_requests review using page where review.workspace_id=page.workspace_id and review.id=page.id and coalesce(review.decided_at,review.expires_at)<=clock_timestamp()-interval '30 days'`,
  },
  {
    name: 'data_table_write_receipts',
    statement: `with page as(select receipt.workspace_id,receipt.execution_id,receipt.invocation_id from app.data_table_write_receipts receipt join app.workflow_runs run on run.workspace_id=receipt.workspace_id and run.id=receipt.run_id where ${bindResourcePredicate(expiredRunSql('run').inlineParams(), [])} order by receipt.execution_id,receipt.invocation_id limit $1) delete from app.data_table_write_receipts receipt using page where receipt.workspace_id=page.workspace_id and receipt.execution_id=page.execution_id and receipt.invocation_id=page.invocation_id`,
  },
  {
    name: 'trigger_skips',
    statement: `with page as (select id from app.usage_events where category in ('trigger.skipped','trigger.coordinated') and occurred_at<=clock_timestamp()-${bindResourcePredicate(RUN_SUMMARY_RETENTION_SQL.inlineParams(), [])} order by occurred_at,id limit $1) delete from app.usage_events event using page where event.id=page.id and event.category in ('trigger.skipped','trigger.coordinated') and event.occurred_at<=clock_timestamp()-${bindResourcePredicate(RUN_SUMMARY_RETENTION_SQL.inlineParams(), [])}`,
  },
  {
    name: 'workflow_test_suites',
    statement: `with page as(select id from app.workflow_test_suites where expires_at<=clock_timestamp() order by expires_at,id limit $1)
     delete from app.workflow_test_suites suite using page where suite.id=page.id and suite.expires_at<=clock_timestamp()`,
  },
  {
    name: 'workflow_test_snapshots',
    statement: `with page as(select snapshot.id from app.workflow_test_snapshots snapshot
     where snapshot.expires_at<=clock_timestamp() and not exists(select 1 from app.workflow_test_suites suite where suite.workspace_id=snapshot.workspace_id and suite.snapshot_id=snapshot.id)
     and not exists(select 1 from app.workflow_runs run where run.workspace_id=snapshot.workspace_id and run.workflow_version_id=snapshot.id and ${bindResourcePredicate(testRunSql('run').inlineParams(), [])} and (run.status in ('queued','running','waiting') or ${bindResourcePredicate(retainedTestRunSql('run').inlineParams(), [])}))
     order by snapshot.expires_at,snapshot.id limit $1)
     delete from app.workflow_test_snapshots snapshot using page where snapshot.id=page.id and snapshot.expires_at<=clock_timestamp()
      and not exists(select 1 from app.workflow_runs run where run.workspace_id=snapshot.workspace_id and run.workflow_version_id=snapshot.id and ${bindResourcePredicate(testRunSql('run').inlineParams(), [])} and (run.status in ('queued','running','waiting') or ${bindResourcePredicate(retainedTestRunSql('run').inlineParams(), [])}))`,
  },
  {
    name: 'webhook_responses',
    statement: `with page as (
      select response.run_id from app.webhook_run_responses response
      join app.workflow_runs run on run.workspace_id=response.workspace_id and run.id=response.run_id
      where run.completed_at<=clock_timestamp()-${bindResourcePredicate(RUN_DETAILS_RETENTION_SQL.inlineParams(), [])} order by response.run_id limit $1
    ) delete from app.webhook_run_responses response using page where response.run_id=page.run_id`,
  },
  {
    // Live human interactions may outlast the normal input window.
    name: 'run_inputs',
    statement: `
      with page as (
        select id from app.workflow_runs run
        where input_ref is not null and input_ref_expires_at <= clock_timestamp()
          and status not in ('queued','running','waiting')
        order by input_ref_expires_at, id limit $1 for update skip locked
      )
      update app.workflow_runs run
      set input_ref = null, input_ref_expires_at = null, updated_at = clock_timestamp()
      from page where run.id = page.id`,
  },
  CALLBACK_TASK_RETENTION_RULE,
  {
    // Test details follow the creation window; ordinary details follow completion.
    // Deleting a node run also deletes its attempts.
    name: 'node_runs',
    statement: `
      with page as (
        select node.workspace_id, node.id
        from app.node_runs node
        join app.workflow_runs run
          on run.workspace_id = node.workspace_id and run.id = node.workflow_run_id
        where ${bindResourcePredicate(expiredRunSql('run').inlineParams(), [])}
        order by node.id limit $1
      )
      delete from app.node_runs node using page
      where node.workspace_id = page.workspace_id and node.id = page.id`,
  },
  {
    name: 'run_events',
    statement: `
      with page as (
        select event.workflow_run_id, event.sequence
        from app.run_events event
        join app.workflow_runs run
          on run.workspace_id = event.workspace_id and run.id = event.workflow_run_id
        where ${bindResourcePredicate(expiredRunSql('run').inlineParams(), [])}
        order by event.workflow_run_id, event.sequence limit $1
      )
      delete from app.run_events event using page
      where event.workflow_run_id = page.workflow_run_id
        and event.sequence = page.sequence`,
  },
  {
    name: 'run_checkpoints',
    statement: `
      with page as (
        select checkpoint.workflow_run_id
        from app.run_checkpoints checkpoint
        join app.workflow_runs run
          on run.workspace_id = checkpoint.workspace_id
         and run.id = checkpoint.workflow_run_id
        where ${bindResourcePredicate(expiredRunSql('run').inlineParams(), [])}
        order by checkpoint.workflow_run_id limit $1
      )
      delete from app.run_checkpoints checkpoint using page
      where checkpoint.workflow_run_id = page.workflow_run_id`,
  },
  CALL_DETAILS_RETENTION_RULE,
  {
    // The run summary stays; its output, error and cancel reason go with the
    // details.
    name: 'run_details',
    statement: `
      with page as (
        select run.id from app.workflow_runs run
        where run.details_purged_at is null
          and ${bindResourcePredicate(expiredRunSql('run').inlineParams(), [])}
          and not exists (select 1 from app.workflow_run_values value
            where value.workspace_id = run.workspace_id and value.workflow_run_id = run.id)
          and not exists (select 1 from app.pending_run_tasks task
            where task.workspace_id = run.workspace_id and task.run_id = run.id and task.kind='callback')
          and not exists (select 1 from app.node_runs node
            where node.workspace_id = run.workspace_id and node.workflow_run_id = run.id)
          and not exists (select 1 from app.run_events event
            where event.workspace_id = run.workspace_id and event.workflow_run_id = run.id)
          and not exists (select 1 from app.run_checkpoints checkpoint
            where checkpoint.workspace_id = run.workspace_id
              and checkpoint.workflow_run_id = run.id)
        order by run.completed_at, run.id limit $1 for update skip locked
      )
      update app.workflow_runs run
      set output_ref = null, error_summary = null, cancel_reason = null, variable_set_revision = null,
          details_purged_at = clock_timestamp(), updated_at = clock_timestamp()
      from page where run.id = page.id`,
  },
  {
    // Webhook replay records keep their own expiry.
    name: 'webhook_replay_records',
    statement: `
      with page as (
        select endpoint_id, dedupe_kind, dedupe_key_hash
        from app.webhook_trigger_replay_records
        where expires_at <= clock_timestamp()
        order by expires_at, endpoint_id limit $1
      )
      delete from app.webhook_trigger_replay_records replay using page
      where replay.endpoint_id = page.endpoint_id
        and replay.dedupe_kind = page.dedupe_kind
        and replay.dedupe_key_hash = page.dedupe_key_hash`,
  },
  {
    name: 'webhook_deliveries',
    statement: `
      with page as (
        select delivery.id from app.webhook_trigger_deliveries delivery
        where delivery.expires_at <= clock_timestamp()
          and not exists (select 1 from app.webhook_trigger_replay_records replay
            where replay.workspace_id = delivery.workspace_id
              and replay.delivery_id = delivery.id)
        order by delivery.expires_at, delivery.id limit $1
      )
      delete from app.webhook_trigger_deliveries delivery using page
      where delivery.id = page.id`,
  },
  {
    name: 'coordinated_events',
    statement: `with page as(select event.id from app.trigger_coordinated_events event where event.status<>'pending' and event.expires_at<=clock_timestamp() and not exists(select 1 from app.webhook_trigger_deliveries delivery where delivery.workspace_id=event.workspace_id and delivery.coordination_event_id=event.id) and not exists(select 1 from app.webhook_trigger_replay_records replay where replay.workspace_id=event.workspace_id and replay.coordination_event_id=event.id) order by event.expires_at,event.id limit $1) delete from app.trigger_coordinated_events event using page where event.id=page.id and event.status<>'pending' and event.expires_at<=clock_timestamp()`,
  },
  {
    name: 'event_windows',
    statement: `with page as(select state.id from app.trigger_event_windows state where state.expires_at<=clock_timestamp() and not exists(select 1 from app.trigger_coordinated_events event where event.workspace_id=state.workspace_id and event.key_id=state.id) order by state.expires_at,state.id limit $1) delete from app.trigger_event_windows state using page where state.id=page.id and state.expires_at<=clock_timestamp() and not exists(select 1 from app.trigger_coordinated_events event where event.workspace_id=state.workspace_id and event.key_id=state.id)`,
  },
  {
    name: 'schedule_occurrences',
    statement: `
      with page as (
        select id from app.trigger_schedule_occurrences
        where scheduled_at <= clock_timestamp() - interval '90 days'
        order by scheduled_at, id limit $1
      )
      delete from app.trigger_schedule_occurrences occurrence using page
      where occurrence.id = page.id`,
  },
  CALL_CHILD_REFERENCES_RETENTION_RULE,
  {
    // A run summary goes 90 days after completion, once nothing refers to it.
    name: 'run_summaries',
    statement: `
      with page as (
        select run.id from app.workflow_runs run
        where ${bindResourcePredicate(expiredRunSql('run', 'summary').inlineParams(), [])}
          and run.details_purged_at is not null
          and not exists (select 1 from app.workflow_calls call
            where call.workspace_id = run.workspace_id
              and (call.live_child_run_id = run.id
                or (call.parent_run_id = run.id and (
                  call.slot_lent or call.status in ('pending','accepted')
                  or (call.cancel_requested_at is not null and call.cancel_applied_at is null)))))
          and not exists (select 1 from app.workflow_runs child
            where child.workspace_id = run.workspace_id
              and child.replay_source_run_id = run.id)
          and not exists (select 1 from app.webhook_trigger_deliveries delivery
            where delivery.workspace_id = run.workspace_id
              and delivery.workflow_run_id = run.id)
          and not exists (select 1 from app.webhook_trigger_replay_records replay
            where replay.workspace_id = run.workspace_id
              and replay.workflow_run_id = run.id)
          and not exists (select 1 from app.trigger_coordinated_events event where event.workspace_id=run.workspace_id and event.run_id=run.id)
          and not exists (select 1 from app.trigger_schedule_occurrences occurrence
            where occurrence.workspace_id = run.workspace_id
              and occurrence.workflow_run_id = run.id)
        order by run.completed_at, run.id limit $1 for update skip locked
      )
      delete from app.workflow_runs run using page where run.id = page.id`,
  },
  {
    name: 'audit_events',
    statement: `
      with page as (
        select audit.id from app.audit_events audit
        join app.workspaces workspace on workspace.id=audit.workspace_id
        where audit.occurred_at <= statement_timestamp() - ${String(AUDIT_RETENTION_MIN_DAYS)} * interval '1 day'
          and audit.occurred_at <= statement_timestamp() - workspace.audit_retention_days * interval '1 day'
        order by audit.occurred_at, audit.id limit $1 for update of audit skip locked
      )
      delete from app.audit_events audit using page where audit.id = page.id`,
  },
  {
    name: 'transport_security_audit_facts',
    statement: `
      with page as (
        select id from app.transport_security_audit_facts
        where occurred_at <= clock_timestamp() - interval '365 days'
        order by occurred_at, id limit $1
      )
      delete from app.transport_security_audit_facts fact using page
      where fact.id = page.id`,
  },
  {
    // A command's stored result answers retries until its key expires.
    name: 'idempotency_records',
    statement: `
      with page as (
        select id from app.idempotency_records
        where status = 'completed' and expires_at <= clock_timestamp()
        order by expires_at, id limit $1
      )
      delete from app.idempotency_records record using page
      where record.id = page.id`,
  },
  {
    name: 'workspace_creation_records',
    statement: `
      with page as (
        select id from app.workspace_creation_idempotency_records
        where status in ('completed', 'failed') and expires_at <= clock_timestamp()
        order by expires_at, id limit $1
      )
      delete from app.workspace_creation_idempotency_records record using page
      where record.id = page.id`,
  },
  {
    name: 'manual_start_rejections',
    statement: `
      with page as (
        select workspace_id, scope, key_hash
        from app.workflow_manual_start_rejections
        where expires_at <= clock_timestamp()
        order by expires_at limit $1
      )
      delete from app.workflow_manual_start_rejections rejection using page
      where (rejection.workspace_id, rejection.scope, rejection.key_hash)
        = (page.workspace_id, page.scope, page.key_hash)`,
  },
  {
    // Sessions are kept 30 days after they end, for sign-in history.
    name: 'auth_sessions',
    statement: `
      with page as (
        select id from app.auth_sessions
        where expires_at <= clock_timestamp() - interval '30 days'
        order by expires_at, id limit $1
      )
      delete from app.auth_sessions session using page
      where session.id = page.id
        and session.expires_at <= clock_timestamp() - interval '30 days'`,
  },
  {
    name: 'auth_method_link_attempts',
    statement: `
      with page as (
        select id from app.auth_method_link_attempts
        where expires_at <= clock_timestamp() - interval '30 days'
        order by expires_at, id limit $1
      )
      delete from app.auth_method_link_attempts attempt using page
      where attempt.id = page.id`,
  },
  {
    name: 'auth_federation_attempts',
    statement: `with page as (
      select id from app.auth_federation_attempts
      where expires_at<=clock_timestamp()-interval '1 day'
      order by expires_at,id limit $1
    ) delete from app.auth_federation_attempts attempt using page where attempt.id=page.id`,
  },
  {
    name: 'auth_sign_in_attempts',
    statement: `with page as (
      select id from app.auth_sign_in_attempts
      where expires_at<=clock_timestamp()-interval '1 day'
      order by expires_at,id limit $1
    ) delete from app.auth_sign_in_attempts attempt using page where attempt.id=page.id`,
  },
  {
    name: 'auth_email_proofs',
    statement: `
      with page as (
        select id from app.auth_email_proofs
        where expires_at <= clock_timestamp() - interval '30 days'
        order by expires_at, id limit $1
      )
      delete from app.auth_email_proofs proof using page
      where proof.id = page.id`,
  },
  INBOX_RETENTION_RULE,
  {
    name: 'identity_security_audit_facts',
    statement: `
      with page as (
        select id from app.identity_security_audit_facts
        where occurred_at <= clock_timestamp() - interval '365 days'
        order by occurred_at, id limit $1
      )
      delete from app.identity_security_audit_facts fact using page
      where fact.id = page.id`,
  },
  {
    // Mail that was not sent within a day, or after 12 attempts, is given up:
    // its sealed payload is dropped and an operator reconciles it.
    // These durable maintenance rule identities predate the system-mail table name.
    name: 'unsent_authentication_mail',
    statement: `
      with page as (
        select id from app.system_mail_deliveries
        where status in ('queued', 'outcome_unknown', 'retry')
          and (expires_at <= clock_timestamp()
            or created_at + interval '24 hours' <= clock_timestamp()
            or attempt_count >= 12)
          and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
        order by created_at, id limit $1 for update skip locked
      )
      update app.system_mail_deliveries delivery
      set status = case when delivery.expires_at <= clock_timestamp()
                        then 'expired' else 'reconciliation_required' end,
          payload_ciphertext = null, payload_nonce = null, payload_tag = null,
          payload_key_version = null, lease_owner = null, lease_token = null,
          lease_expires_at = null, completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      from page where delivery.id = page.id`,
  },
  {
    name: 'authentication_mail',
    statement: `
      with page as (
        select id from app.system_mail_deliveries
        where status in ('submitted', 'failed', 'reconciliation_required', 'expired')
          and completed_at <= clock_timestamp() - interval '30 days'
        order by completed_at, id limit $1
      )
      delete from app.system_mail_deliveries delivery using page
      where delivery.id = page.id`,
  },
  {
    // An unanswered invitation expires: its sealed tokens are dropped and
    // pending deliveries and acceptances stop.
    name: 'invitation_expiry',
    statement: `
      with page as (
        select workspace_id, id from app.workspace_invitations
        where status = 'pending' and expires_at <= clock_timestamp()
        order by expires_at, id limit $1 for update skip locked
      ), expired as (
        update app.workspace_invitations invitation
        set status = 'expired', delivery_status = 'canceled',
            updated_at = clock_timestamp()
        from page
        where invitation.workspace_id = page.workspace_id and invitation.id = page.id
        returning invitation.workspace_id, invitation.id
      ), attempts as (
        update app.workspace_invitation_delivery_attempts attempt
        set status = case when attempt.status in ('queued', 'failed')
                          then 'canceled' else attempt.status end,
            token_ciphertext = null, token_nonce = null, token_tag = null,
            token_key_version = null, updated_at = clock_timestamp()
        from expired
        where attempt.workspace_id = expired.workspace_id
          and attempt.invitation_id = expired.id
          and attempt.status in ('queued', 'failed', 'unknown')
      ), intents as (
        update app.workspace_invitation_acceptance_intents intent
        set status = 'superseded', updated_at = clock_timestamp()
        from expired
        where intent.workspace_id = expired.workspace_id
          and intent.invitation_id = expired.id
          and intent.status in ('pending', 'verified', 'wrong_account')
      )
      select 1 from expired`,
  },
  {
    name: 'invitation_acceptance_intents',
    statement: `
      with page as (
        select workspace_id, id from app.workspace_invitation_acceptance_intents
        where expires_at <= clock_timestamp() or status = 'abandoned'
        order by expires_at, id limit $1 for update skip locked
      )
      delete from app.workspace_invitation_acceptance_intents intent using page
      where intent.workspace_id = page.workspace_id and intent.id = page.id`,
  },
  {
    name: 'invitation_replacement_claims',
    run: reapInvitationReplacementClaims,
  },
  {
    // A finished invitation keeps its recipient's address for 90 days.
    name: 'invitation_recipients',
    statement: `
      with page as (
        select id, 'minimized+' || id::text || '@invalid.pertexo' address
        from app.workspace_invitations
        where status in ('accepted', 'revoked', 'expired')
          and recipient_email not like 'minimized+%@invalid.pertexo'
          and coalesce(accepted_at, revoked_at, updated_at)
            <= clock_timestamp() - interval '90 days'
        order by coalesce(accepted_at, revoked_at, updated_at), id
        limit $1 for update skip locked
      ), intents as (
        update app.workspace_invitation_acceptance_intents intent
        set verified_user_id = null, verified_session_id=null, verified_email = null, verified_at = null,
            updated_at = clock_timestamp()
        from page
        where intent.invitation_id = page.id and intent.verified_email is not null
      )
      update app.workspace_invitations invitation
      set recipient_email = page.address, normalized_email = page.address,
          updated_at = clock_timestamp()
      from page where invitation.id = page.id`,
  },
  {
    // Payloads of deleted cases and of earlier case revisions.
    name: 'input_case_payloads',
    statement: `
      with page as (
        select payload.workspace_id, payload.case_id, payload.revision
        from app.workflow_input_case_payloads payload
        join app.workflow_input_cases input_case
          on input_case.workspace_id = payload.workspace_id
         and input_case.id = payload.case_id
        where input_case.deleted_at is not null
           or payload.revision < input_case.revision
        order by payload.workspace_id, payload.case_id, payload.revision limit $1
      )
      delete from app.workflow_input_case_payloads payload using page
      where (payload.workspace_id, payload.case_id, payload.revision)
        = (page.workspace_id, page.case_id, page.revision)`,
  },
  {
    // A deleted case goes once its payloads are gone.
    name: 'deleted_input_cases',
    statement: `
      with page as (
        select input_case.workspace_id, input_case.id
        from app.workflow_input_cases input_case
        where input_case.deleted_at is not null
          and not exists (select 1 from app.workflow_input_case_payloads payload
            where payload.workspace_id = input_case.workspace_id
              and payload.case_id = input_case.id)
        order by input_case.workspace_id, input_case.id limit $1
      )
      delete from app.workflow_input_cases input_case using page
      where input_case.workspace_id = page.workspace_id and input_case.id = page.id`,
  },
  {
    name: 'workflow_step_samples',
    statement: `with page as (select workspace_id,id from app.workflow_step_samples where expires_at <= clock_timestamp() order by expires_at,id limit $1) delete from app.workflow_step_samples sample using page where sample.workspace_id=page.workspace_id and sample.id=page.id`,
  },
  {
    name: 'webhook_test_events',
    statement: `with page as (select workspace_id,id from app.webhook_test_events where expires_at<=clock_timestamp() order by expires_at,id limit $1 for update skip locked) delete from app.webhook_test_events event using page where event.workspace_id=page.workspace_id and event.id=page.id`,
  },
  VARIABLE_SET_RETENTION_RULE,
] as const);

export type RetentionRuleName = (typeof RETENTION_RULES)[number]['name'];
