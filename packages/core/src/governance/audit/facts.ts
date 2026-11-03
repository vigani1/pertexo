import {
  appendAuditFact as persistAuditFact,
  appendAuditFacts as persistAuditFacts,
  type AuditFact as StoredAuditFact,
} from '@pertexo/database/primitives';
import type { AuditViewKey } from './projection.js';

/**
 * Facts a row keeps for investigation that the audit view leaves out. A key in
 * neither this list nor `AuditViewKey` fails to compile, so a writer's new fact
 * can't vanish from the view without someone choosing that.
 */
type AuditStoredOnlyKey =
  | 'access'
  | 'acknowledgePossibleEffects'
  | 'acknowledgeUnknownOutcome'
  | 'acknowledgedTargetChanges'
  | 'activationStatus'
  | 'authType'
  | 'authenticationMode'
  | 'checksum'
  | 'columns'
  | 'commentId'
  | 'decision'
  | 'deleted'
  | 'destinationId'
  | 'detachedWorkflowCount'
  | 'domainId'
  | 'effectRisk'
  | 'expiresAt'
  | 'failures'
  | 'lastRunId'
  | 'threshold'
  | 'fromName'
  | 'fromNameRevision'
  | 'fromStatus'
  | 'invitationRevision'
  | 'keyColumn'
  | 'kind'
  | 'lifecycleRevision'
  | 'lifecycleStatus'
  | 'limit'
  | 'mayCauseExternalSideEffect'
  | 'mayContactProvider'
  | 'members'
  | 'membershipCreated'
  | 'mode'
  | 'nodeId'
  | 'organizationRevision'
  | 'outcome'
  | 'overflow'
  | 'pinnedSampleId'
  | 'previewAttemptId'
  | 'previousActivationStatus'
  | 'previousLifecycleRevision'
  | 'previousLifecycleStatus'
  | 'previousOwnerFromRevision'
  | 'previousOwnerToRevision'
  | 'previousRevision'
  | 'previousShares'
  | 'priorErrorCode'
  | 'priorFailedAt'
  | 'priorPublishAttempts'
  | 'promotionId'
  | 'providerId'
  | 'providerKey'
  | 'providerRevision'
  | 'publishedVersionId'
  | 'purpose'
  | 'reason'
  | 'reasonProvided'
  | 'replayed'
  | 'requestFingerprint'
  | 'reusedCount'
  | 'settings'
  | 'shares'
  | 'sideEffectClass'
  | 'sourceKind'
  | 'sourceRunId'
  | 'sourceVersionId'
  | 'sourceWorkflowId'
  | 'sourceWorkspaceId'
  | 'targetNodeId'
  | 'targetNodeRunId'
  | 'targetVersionId'
  | 'targetWorkflowId'
  | 'targetWorkspaceId'
  | 'threadDeleted'
  | 'threadId'
  | 'toName'
  | 'toNameRevision'
  | 'version'
  | 'workflowName'
  | 'workflowVersionId';

export type AuditMetadata = Readonly<
  Partial<Record<AuditViewKey | AuditStoredOnlyKey, unknown>>
>;

type AuditWriter = Parameters<typeof persistAuditFact>[0];
export type AuditFact = Omit<StoredAuditFact, 'metadata'> &
  Readonly<{ metadata?: AuditMetadata }>;

/** Every core fact chooses whether each metadata key belongs in the audit view. */
export function appendAuditFact(
  writer: AuditWriter,
  fact: AuditFact,
): Promise<void> {
  return persistAuditFact(writer, fact);
}
export function appendAuditFacts(
  writer: AuditWriter,
  facts: readonly AuditFact[],
): Promise<void> {
  return persistAuditFacts(writer, facts);
}
