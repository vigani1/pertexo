import { reapInvitationReplacementClaims } from './invitation-claims.js';

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
  {
    // A run's input is kept until the expiry recorded with it.
    name: 'run_inputs',
    statement: `
      with page as (
        select id from app.workflow_runs
        where input_ref is not null and input_ref_expires_at <= clock_timestamp()
        order by input_ref_expires_at, id limit $1 for update skip locked
      )
      update app.workflow_runs run
      set input_ref = null, input_ref_expires_at = null, updated_at = clock_timestamp()
      from page where run.id = page.id`,
  },
  {
    // Execution details go 30 days after a run completes. Deleting a node run
    // deletes its attempts.
    name: 'node_runs',
    statement: `
      with page as (
        select node.workspace_id, node.id
        from app.node_runs node
        join app.workflow_runs run
          on run.workspace_id = node.workspace_id and run.id = node.workflow_run_id
        where run.completed_at <= clock_timestamp() - interval '30 days'
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
        where run.completed_at <= clock_timestamp() - interval '30 days'
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
        where run.completed_at <= clock_timestamp() - interval '30 days'
        order by checkpoint.workflow_run_id limit $1
      )
      delete from app.run_checkpoints checkpoint using page
      where checkpoint.workflow_run_id = page.workflow_run_id`,
  },
  {
    // The run summary stays; its output, error and cancel reason go with the
    // details.
    name: 'run_details',
    statement: `
      with page as (
        select run.id from app.workflow_runs run
        where run.details_purged_at is null
          and run.completed_at <= clock_timestamp() - interval '30 days'
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
      set output_ref = null, error_summary = null, cancel_reason = null,
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
  {
    // A run summary goes 90 days after completion, once nothing refers to it.
    name: 'run_summaries',
    statement: `
      with page as (
        select run.id from app.workflow_runs run
        where run.completed_at <= clock_timestamp() - interval '90 days'
          and run.details_purged_at is not null
          and not exists (select 1 from app.workflow_runs child
            where child.workspace_id = run.workspace_id
              and child.replay_source_run_id = run.id)
          and not exists (select 1 from app.webhook_trigger_deliveries delivery
            where delivery.workspace_id = run.workspace_id
              and delivery.workflow_run_id = run.id)
          and not exists (select 1 from app.webhook_trigger_replay_records replay
            where replay.workspace_id = run.workspace_id
              and replay.workflow_run_id = run.id)
          and not exists (select 1 from app.trigger_schedule_occurrences occurrence
            where occurrence.workspace_id = run.workspace_id
              and occurrence.workflow_run_id = run.id)
        order by run.completed_at, run.id limit $1 for update skip locked
      )
      delete from app.workflow_runs run using page where run.id = page.id`,
  },
  {
    // Audit records are kept for a year.
    name: 'audit_events',
    statement: `
      with page as (
        select id from app.audit_events
        where occurred_at <= clock_timestamp() - interval '365 days'
        order by occurred_at, id limit $1
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
  {
    // An inbox thread goes 30 days after its latest failure.
    name: 'workspace_inbox_threads',
    statement: `
      with page as (
        select workspace_id, workflow_id from app.workspace_inbox_threads
        where latest_occurred_at <= statement_timestamp() - interval '720 hours'
        order by latest_occurred_at, workspace_id, workflow_id limit $1
      )
      delete from app.workspace_inbox_threads thread using page
      where (thread.workspace_id, thread.workflow_id)
        = (page.workspace_id, page.workflow_id)`,
  },
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
    name: 'unsent_authentication_mail',
    statement: `
      with page as (
        select id from app.authentication_mail_deliveries
        where status in ('queued', 'outcome_unknown', 'retry')
          and (expires_at <= clock_timestamp()
            or created_at + interval '24 hours' <= clock_timestamp()
            or attempt_count >= 12)
          and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
        order by created_at, id limit $1 for update skip locked
      )
      update app.authentication_mail_deliveries delivery
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
        select id from app.authentication_mail_deliveries
        where status in ('submitted', 'failed', 'reconciliation_required', 'expired')
          and completed_at <= clock_timestamp() - interval '30 days'
        order by completed_at, id limit $1
      )
      delete from app.authentication_mail_deliveries delivery using page
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
        set verified_user_id = null, verified_email = null, verified_at = null,
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
] as const);

export type RetentionRuleName = (typeof RETENTION_RULES)[number]['name'];
