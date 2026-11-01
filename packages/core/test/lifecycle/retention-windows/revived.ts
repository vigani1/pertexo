import type { RetentionRuleName } from '../../../src/lifecycle/retention/rules.js';

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
