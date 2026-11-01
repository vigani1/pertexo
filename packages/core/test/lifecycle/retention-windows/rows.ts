import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { RetentionRuleName } from '../../../src/lifecycle/retention/rules.js';
import { userId, workspaceId } from '../retention.support.js';

const HOUR = 3_600_000;

type Row = Readonly<Record<string, unknown>>;

export type WindowedRule = Readonly<{
  rule: RetentionRuleName;
  table: string;
  /** How long past `at` a row is kept. */
  windowDays: number;
  /** The column naming a row, for telling which ones survived. */
  key?: string;
  /** A row whose retention clock reads `at`. */
  row: (at: Date) => Row;
}>;

const hex = () => createHash('sha256').update(randomUUID()).digest('hex');
const digest = () => randomBytes(32);
const before = (at: Date) => new Date(at.getTime() - HOUR);
const SAMPLE_BINDING = '{}';
const SAMPLE_OUTPUT = '{"kind":"inline","value":1}';

/**
 * One row per retention clock. Parents that a rule never reads aren't seeded;
 * the fixture writes with foreign keys off, as a rule's window doesn't depend
 * on them. Windows are the product's: 30 days of sign-in history, a day of
 * sign-in attempts, a year of security facts, and so on.
 */
export const WINDOWED_RULES: readonly WindowedRule[] = [
  {
    rule: 'provisioning_credentials',
    table: 'auth_provisioning_credentials',
    windowDays: 30,
    row: (at) => ({
      id: randomUUID(),
      organization_id: workspaceId,
      name: 'Directory sync',
      secret_digest: hex(),
      revoked_at: at,
    }),
  },
  {
    rule: 'auth_sessions',
    table: 'auth_sessions',
    windowDays: 30,
    row: (at) => ({
      id: randomUUID(),
      token: randomUUID(),
      user_id: userId,
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'auth_method_link_attempts',
    table: 'auth_method_link_attempts',
    windowDays: 30,
    row: (at) => ({
      id: randomUUID(),
      user_id: userId,
      session_id: randomUUID(),
      browser_digest: digest(),
      source_provider: 'credential',
      target_provider: 'google',
      phase: 'source',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'auth_federation_attempts',
    table: 'auth_federation_attempts',
    windowDays: 1,
    row: (at) => ({
      id: randomUUID(),
      organization_id: workspaceId,
      provider_id: randomUUID(),
      provider_revision: 1,
      domain_id: randomUUID(),
      purpose: 'sign_in',
      state_digest: digest(),
      browser_digest: digest(),
      return_path: '/',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'auth_sign_in_attempts',
    table: 'auth_sign_in_attempts',
    windowDays: 1,
    row: (at) => ({
      id: randomUUID(),
      provider: 'google',
      state_digest: digest(),
      browser_digest: digest(),
      return_path: '/',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'auth_email_proofs',
    table: 'auth_email_proofs',
    windowDays: 30,
    row: (at) => ({
      id: randomUUID(),
      token_digest: digest(),
      user_id: userId,
      purpose: 'initial_verification',
      email: `${randomUUID()}@example.test`,
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'identity_security_audit_facts',
    table: 'identity_security_audit_facts',
    windowDays: 365,
    row: (at) => ({
      id: randomUUID(),
      user_id: userId,
      event_type: 'password.changed',
      occurred_at: at,
    }),
  },
  {
    rule: 'transport_security_audit_facts',
    table: 'transport_security_audit_facts',
    windowDays: 365,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      fact_type: 'inbox_checksum_mismatch',
      consumer_name: 'retention.test',
      message_id: randomUUID(),
      occurred_at: at,
    }),
  },
  {
    rule: 'trigger_skips',
    table: 'usage_events',
    windowDays: 90,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      category: 'trigger.skipped',
      quantity: 1,
      resource_type: 'trigger',
      resource_id: randomUUID(),
      idempotency_key: randomUUID(),
      occurred_at: at,
    }),
  },
  {
    rule: 'schedule_occurrences',
    table: 'trigger_schedule_occurrences',
    windowDays: 90,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      trigger_id: randomUUID(),
      scheduled_at: at,
      disposition: 'skipped',
      created_at: at,
    }),
  },
  {
    rule: 'publication_requests',
    table: 'workflow_publication_requests',
    windowDays: 30,
    row: (at) => ({
      workspace_id: workspaceId,
      id: randomUUID(),
      workflow_id: randomUUID(),
      requested_by: userId,
      draft_revision: 1,
      representation_tag: `"draft.${'A'.repeat(43)}"`,
      note: 'Please review',
      status: 'pending',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'idempotency_records',
    table: 'idempotency_records',
    windowDays: 0,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      operation: 'connection.update',
      scope: 'connection:test',
      key_hash: hex(),
      request_hash: hex(),
      status: 'completed',
      resource_id: randomUUID(),
      result_ref: '{}',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'workspace_creation_records',
    table: 'workspace_creation_idempotency_records',
    windowDays: 0,
    row: (at) => ({
      id: randomUUID(),
      actor_user_id: userId,
      operation: 'workspace.create',
      key_hash: hex(),
      request_hash: hex(),
      status: 'failed',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'manual_start_rejections',
    table: 'workflow_manual_start_rejections',
    key: 'key_hash',
    windowDays: 0,
    row: (at) => {
      const workflowId = randomUUID();
      return {
        workspace_id: workspaceId,
        workflow_id: workflowId,
        scope: `workflow:${workflowId}:manual`,
        key_hash: hex(),
        request_hash: hex(),
        expected_version_id: randomUUID(),
        observed_version_id: randomUUID(),
        expires_at: at,
      };
    },
  },
  {
    rule: 'webhook_replay_records',
    table: 'webhook_trigger_replay_records',
    key: 'dedupe_key_hash',
    windowDays: 0,
    row: (at) => ({
      workspace_id: workspaceId,
      endpoint_id: randomUUID(),
      dedupe_key_hash: hex(),
      request_fingerprint: hex(),
      delivery_id: randomUUID(),
      expires_at: at,
      created_at: new Date(at.getTime() - 24 * HOUR),
    }),
  },
  {
    rule: 'webhook_deliveries',
    table: 'webhook_trigger_deliveries',
    windowDays: 0,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      endpoint_id: randomUUID(),
      outcome: 'invalid_request',
      http_status: 400,
      signature_check: 'verified',
      replay_check: 'not_checked',
      received_at: new Date(at.getTime() - 90 * 24 * HOUR),
      expires_at: at,
    }),
  },
  {
    rule: 'coordinated_events',
    table: 'trigger_coordinated_events',
    windowDays: 0,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      workflow_id: randomUUID(),
      node_id: 'webhook',
      source: 'webhook',
      mode: 'debounce',
      initial_outcome: 'skipped',
      status: 'skipped',
      initial_status: 'skipped',
      version_number: 1,
      input_bytes: 0,
      received_at: new Date(at.getTime() - 90 * 24 * HOUR),
      finished_at: before(at),
      expires_at: at,
    }),
  },
  {
    rule: 'event_windows',
    table: 'trigger_event_windows',
    windowDays: 0,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      workflow_id: randomUUID(),
      node_id: 'webhook',
      policy_hash: hex(),
      key_hash: hex(),
      window_started_at: before(at),
      expires_at: at,
    }),
  },
  {
    rule: 'workflow_presence_leases',
    table: 'workflow_presence_leases',
    key: 'tab_id',
    windowDays: 0,
    row: (at) => ({
      workspace_id: workspaceId,
      workflow_id: randomUUID(),
      user_id: userId,
      tab_id: randomUUID(),
      sequence: 1,
      editing: false,
      dirty: false,
      last_seen_at: before(at),
      expires_at: at,
    }),
  },
  {
    rule: 'workflow_test_suites',
    table: 'workflow_test_suites',
    windowDays: 0,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      workflow_id: randomUUID(),
      started_by: userId,
      snapshot_id: randomUUID(),
      signature: hex(),
      uses_connections: false,
      case_duration_ms: 1_000,
      initial_checkpoint: '{}',
      status: 'passed',
      deadline_at: new Date(at.getTime() - 60_000),
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'workflow_step_samples',
    table: 'workflow_step_samples',
    windowDays: 0,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      workflow_id: randomUUID(),
      node_id: 'http',
      binding: SAMPLE_BINDING,
      output_ref: SAMPLE_OUTPUT,
      retained_bytes: SAMPLE_BINDING.length + SAMPLE_OUTPUT.length,
      source_kind: 'json',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'webhook_test_events',
    table: 'webhook_test_events',
    windowDays: 0,
    row: (at) => ({
      id: randomUUID(),
      workspace_id: workspaceId,
      workflow_id: randomUUID(),
      node_id: 'webhook',
      created_by: userId,
      endpoint_key_hash: hex(),
      binding: '{}',
      authentication: '{}',
      kms_key_reference: 'self-managed',
      encrypted_data_key: 'Zg',
      ciphertext: 'Zg',
      nonce: 'nonce',
      auth_tag: 'tag',
      expires_at: at,
      created_at: before(at),
    }),
  },
  {
    rule: 'authentication_mail',
    table: 'system_mail_deliveries',
    windowDays: 30,
    row: (at) => ({
      id: randomUUID(),
      purpose: 'verification',
      status: 'submitted',
      expires_at: at,
      completed_at: at,
      created_at: before(at),
    }),
  },
];

/** A row someone brought back to life while its delete waited for the lock. */
export type RevivedRule = Readonly<{
  rule: RetentionRuleName;
  revive: string;
}>;

export const REVIVED_RULES: readonly RevivedRule[] = [
  {
    rule: 'auth_sessions',
    revive: `expires_at=clock_timestamp()+interval '1 day'`,
  },
  { rule: 'provisioning_credentials', revive: 'revoked_at=null' },
  {
    rule: 'publication_requests',
    revive: `expires_at=clock_timestamp()+interval '1 day'`,
  },
  {
    rule: 'trigger_skips',
    revive: 'occurred_at=clock_timestamp()',
  },
  {
    rule: 'event_windows',
    revive: `expires_at=clock_timestamp()+interval '1 day'`,
  },
  {
    rule: 'coordinated_events',
    revive: `received_at=clock_timestamp(),expires_at=clock_timestamp()+interval '90 days'`,
  },
  {
    rule: 'workflow_presence_leases',
    revive: `expires_at=clock_timestamp()+interval '1 day'`,
  },
  {
    rule: 'workflow_test_suites',
    revive: `expires_at=clock_timestamp()+interval '1 day'`,
  },
  // A step's sample is replaced in place by capturing it again.
  {
    rule: 'workflow_step_samples',
    revive: `expires_at=clock_timestamp()+interval '30 days'`,
  },
];
