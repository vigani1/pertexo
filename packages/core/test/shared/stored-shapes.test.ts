import type {
  AcceptanceInput as StoredAcceptanceInput,
  ArtifactStatus as StoredArtifactStatus,
  ConnectionAuthType as StoredConnectionAuthType,
  ConnectionStatus as StoredConnectionStatus,
  DestinationConfig as StoredDestinationConfigKind,
  DirectoryUserProfile as StoredDirectoryUserProfile,
  FailureNotificationClaimResult as StoredClaimResult,
  FolderAccess as StoredFolderAccess,
  FolderFact as StoredFolderFact,
  GenericOperatorCommandResult as StoredOperatorResult,
  NodeAttemptLease as StoredNodeAttemptLease,
  OperatorCommandRecord as StoredOperatorRecord,
  PreviewAttemptLease as StoredPreviewAttemptLease,
  PreviewStatus as StoredPreviewStatus,
  RecordedScheduleOccurrence as StoredOccurrence,
  ScheduleTriggerRecord as StoredScheduleTrigger,
  StoredDestinationConfig,
  WebhookDeliveryOutcome as StoredDeliveryOutcome,
  WebhookReplayCheck as StoredReplayCheck,
  WebhookSignatureCheck as StoredSignatureCheck,
  WorkflowTriggerHealth as StoredTriggerHealth,
} from '@pertexo/database/schema';
import { expectTypeOf, it } from 'vitest';

import type { NodeAttemptLease } from '../../src/attempts/contract.js';
import type { ArtifactStatus } from '../../src/artifacts/contract.js';
import type {
  ConnectionAuthType,
  ConnectionStatus,
} from '../../src/connections/contract.js';
import type { DirectoryUserProfile } from '../../src/identity/federation/provisioning/contract.js';
import type { FailureNotificationClaimResult } from '../../src/notifications/contract.js';
import type {
  DestinationConfig,
  StoredDestinationConfig as AreaStoredDestinationConfig,
} from '../../src/notifications/destinations/contract.js';
import type {
  GenericOperatorCommandResult,
  OperatorCommandRecord,
} from '../../src/operator/contract.js';
import type {
  PreviewAttemptLease,
  PreviewStatus,
} from '../../src/previews/contract.js';
import type { AcceptanceInput } from '../../src/runs/commands/acceptance/input.js';
import type {
  FolderAccess,
  FolderFact,
} from '../../src/tenant-access/resources/contract.js';
import type { WorkflowTriggerHealth } from '../../src/triggers/reconciliation/contract.js';
import type { RecordedScheduleOccurrence } from '../../src/triggers/schedules/contract.js';
import type { ScheduleTriggerRecord } from '../../src/triggers/schedules/management/contract.js';
import type {
  WebhookDeliveryOutcome,
  WebhookReplayCheck,
  WebhookSignatureCheck,
} from '../../src/triggers/webhooks/contract.js';

// `pnpm typecheck` is the real assertion: a schema column and an area's contract
// can't drift apart without this file failing to compile.
it('keeps the types stamped on columns equal to the area contracts', () => {
  expectTypeOf<StoredFolderAccess>().toEqualTypeOf<FolderAccess>();
  expectTypeOf<StoredFolderFact['accessMode']>().toEqualTypeOf<
    FolderFact['accessMode']
  >();
  expectTypeOf<StoredTriggerHealth['kind']>().toEqualTypeOf<
    WorkflowTriggerHealth['kind']
  >();
  expectTypeOf<StoredTriggerHealth['healthStatus']>().toEqualTypeOf<
    WorkflowTriggerHealth['healthStatus']
  >();
  expectTypeOf<StoredConnectionAuthType>().toEqualTypeOf<ConnectionAuthType>();
  expectTypeOf<StoredConnectionStatus>().toEqualTypeOf<ConnectionStatus>();
  expectTypeOf<StoredDirectoryUserProfile>().toEqualTypeOf<DirectoryUserProfile>();
  expectTypeOf<StoredDestinationConfigKind>().toEqualTypeOf<DestinationConfig>();
  expectTypeOf<StoredDestinationConfig>().toEqualTypeOf<AreaStoredDestinationConfig>();
  expectTypeOf<StoredClaimResult['sideEffectClass']>().toEqualTypeOf<
    Extract<
      FailureNotificationClaimResult,
      { kind: 'ready' }
    >['sideEffectClass']
  >();
  expectTypeOf<StoredNodeAttemptLease['sideEffectClass']>().toEqualTypeOf<
    NodeAttemptLease['sideEffectClass']
  >();
  expectTypeOf<StoredNodeAttemptLease['admissionKind']>().toEqualTypeOf<
    NodeAttemptLease['admissionKind']
  >();
  expectTypeOf<StoredPreviewAttemptLease['sideEffectClass']>().toEqualTypeOf<
    PreviewAttemptLease['sideEffectClass']
  >();
  expectTypeOf<StoredPreviewAttemptLease['dryRun']>().toEqualTypeOf<
    PreviewAttemptLease['dryRun']
  >();
  expectTypeOf<StoredPreviewStatus>().toEqualTypeOf<PreviewStatus>();
  expectTypeOf<StoredAcceptanceInput['triggerType']>().toEqualTypeOf<
    AcceptanceInput['triggerType']
  >();
  expectTypeOf<StoredOperatorResult['result']>().toEqualTypeOf<
    GenericOperatorCommandResult['result']
  >();
  expectTypeOf<StoredOperatorResult['status']>().toEqualTypeOf<
    GenericOperatorCommandResult['status']
  >();
  expectTypeOf<StoredOperatorRecord['commandType']>().toEqualTypeOf<
    OperatorCommandRecord['commandType']
  >();
  expectTypeOf<StoredArtifactStatus>().toEqualTypeOf<ArtifactStatus>();
  expectTypeOf<StoredDeliveryOutcome>().toEqualTypeOf<WebhookDeliveryOutcome>();
  expectTypeOf<StoredSignatureCheck>().toEqualTypeOf<WebhookSignatureCheck>();
  expectTypeOf<StoredReplayCheck>().toEqualTypeOf<WebhookReplayCheck>();
  expectTypeOf<StoredOccurrence>().toEqualTypeOf<RecordedScheduleOccurrence>();
  expectTypeOf<StoredScheduleTrigger['misfirePolicy']>().toEqualTypeOf<
    ScheduleTriggerRecord['misfirePolicy']
  >();
  expectTypeOf<StoredScheduleTrigger['healthStatus']>().toEqualTypeOf<
    ScheduleTriggerRecord['healthStatus']
  >();
});
