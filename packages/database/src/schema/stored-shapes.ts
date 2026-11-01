// The column types the schema stamps with `$type`, so tables need no area's code.
// An area's contract still has its own fuller type until that area's pass; the
// compile-time test in core/test/shared/stored-shapes.test.ts holds them equal.
import type {
  ConnectionAuthType,
  ConnectionStatus,
  FailureNotificationDestinationConfig,
} from '@pertexo/workflow-model';

type SideEffectClass = 'safe' | 'idempotent_with_key' | 'unsafe';

export type { ConnectionAuthType, ConnectionStatus };
export type FolderAccess = 'viewer' | 'editor';
export type FolderFact = Readonly<{ accessMode: 'workspace' | 'restricted' }>;
export type WorkflowTriggerHealth = Readonly<{
  kind: 'webhook' | 'schedule';
  healthStatus: 'pending' | 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
}>;
type DirectoryEmail = Readonly<{
  value: string;
  type?: string;
  primary: boolean;
}>;
export type DirectoryUserProfile = Readonly<{
  displayName?: string;
  name?: Readonly<{
    formatted?: string;
    familyName?: string;
    givenName?: string;
    middleName?: string;
    honorificPrefix?: string;
    honorificSuffix?: string;
  }>;
  /** The canonical primary address is first; only verified SSO may bind it. */
  emails: readonly [DirectoryEmail, ...DirectoryEmail[]];
}>;
export type DestinationConfig = FailureNotificationDestinationConfig;
export type StoredDestinationConfig =
  | Omit<Extract<DestinationConfig, { kind: 'email' }>, 'kind'>
  | Omit<Extract<DestinationConfig, { kind: 'slack' }>, 'kind'>;
export type FailureNotificationClaimResult = Readonly<{
  kind: 'ready';
  sideEffectClass: SideEffectClass;
}>;
export type NodeAttemptLease = Readonly<{
  sideEffectClass: SideEffectClass;
  admissionKind: 'execute' | 'retry' | 'wait_resume';
}>;
export type PreviewAttemptLease = Readonly<{
  sideEffectClass: SideEffectClass;
  dryRun: 'not_supported' | 'provider_supported';
}>;
export type PreviewStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timed_out'
  | 'outcome_unknown';
export type AcceptanceInput = Readonly<{
  triggerType:
    | 'test'
    | 'api'
    | 'manual'
    | 'replay'
    | 'schedule'
    | 'webhook'
    | 'workflow_call'
    | 'workflow_error'
    | 'form';
}>;
export type GenericOperatorCommandResult = Readonly<{
  result: Readonly<Record<string, unknown>>;
  status: 'completed' | 'failed' | 'pending';
}>;
export type OperatorCommandRecord = Readonly<{
  commandType:
    | 'attempt.reconcile'
    | 'due-work.resume'
    | 'outbox.redispatch'
    | 'run.cancel'
    | 'run.replay'
    | 'trigger.reconcile'
    | 'unknown-outcome.record-evidence';
}>;
export type ArtifactStatus = 'available' | 'deleted' | 'deleting' | 'pending';
export type WebhookDeliveryOutcome =
  | 'accepted'
  | 'coordinated'
  | 'skipped'
  | 'replayed'
  | 'authentication_failed'
  | 'invalid_request'
  | 'conflict'
  | 'rate_limited'
  | 'paused';
export type WebhookSignatureCheck = 'verified' | 'mismatch' | 'not_checked';
export type WebhookReplayCheck =
  'new' | 'duplicate' | 'conflict' | 'stale_timestamp' | 'not_checked';
export type RecordedScheduleOccurrence = 'accepted' | 'skipped' | 'paused';
export type ScheduleTriggerRecord = Readonly<{
  misfirePolicy: 'skip' | 'catch_up_once';
  healthStatus: 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
}>;
