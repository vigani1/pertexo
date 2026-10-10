import {
  authAccounts,
  authSessions,
  authVerifications,
  userProfileCommandReceipts,
  authMethodLinkAttempts,
  authEmailProofs,
  authenticationMailDeliveries,
  identitySecurityAuditFacts,
} from './schema/authentication.js';
import { workflowTemplateOrigins } from './schema/authoring/template-origin.js';
import { workflowManualStartRejections } from './schema/runs/manual-start.js';
import {
  workflowInputCases,
  workflowInputCasePayloads,
} from './schema/authoring/input-cases.js';
import {
  users,
  workspaces,
  workspaceMemberships,
  workspaceInvitations,
  workspaceInvitationDeliveryAttempts,
  workspaceInvitationAcceptanceIntents,
  workspaceInvitationBindingReplacementClaims,
  auditEvents,
  usageEvents,
  workspaceLifecycleOperations,
} from './schema/foundation.js';
import { rlsProbeRecords } from './schema/rls-probe.js';
import { workflowConcurrencyPolicies } from './schema/authoring/concurrency.js';
import {
  connections,
  connectionSecretVersions,
  connectionEvents,
  nodeAttemptConnectionDispatches,
  connectionHealthObservations,
} from './schema/connections.js';
import {
  artifacts,
  workspaceArtifactCapacity,
  outboxEvents,
  inboxReceipts,
  transportSecurityAuditFacts,
  outboxFairDispatchCursor,
} from './schema/transport.js';
import {
  workflowRuns,
  runEvents,
  runCheckpoints,
  nodeRuns,
  nodeAttempts,
  previewRuns,
  previewAttempts,
} from './schema/runs/execution.js';
import {
  artifactLinks,
  idempotencyRecords,
  workspaceCreationIdempotencyRecords,
} from './schema/runs/support.js';
import {
  workflows,
  workflowDrafts,
  workflowVersions,
  workflowTriggers,
} from './schema/authoring/workflows.js';
import { workflowIntegrationUsage } from './schema/authoring/integrations.js';
import {
  workspaceInboxEvents,
  workspaceInboxReads,
  workspaceInboxThreads,
} from './schema/workspace-inbox.js';
import {
  workflowFailureStreaks,
  workflowTriggerOutcomes,
  workflowTriggerPausePeriods,
} from './schema/trigger-pause.js';
import {
  webhookTriggerSecretVersions,
  webhookTriggerEndpoints,
  webhookTriggerDeliveries,
  webhookEndpointIngressLimits,
  webhookTriggerReplayRecords,
  triggerSchedules,
  triggerScheduleOccurrences,
} from './schema/triggers.js';

import {
  workflowFolders,
  workflowTags,
  workflowOrganizationState,
  workflowTagAssignments,
  workflowFavorites,
} from './schema/authoring/organization.js';
import {
  failureNotificationDestinations,
  failureNotificationDestinationVersions,
  workflowFailureNotificationPolicies,
} from './schema/notifications.js';
import {
  runFailureNotificationIntents,
  runFailureNotificationAuditFacts,
} from './schema/runs/notifications.js';
import {
  operatorCommands,
  operatorRunReplayRequests,
  operatorUnknownOutcomeEvidence,
} from './schema/runs/operator.js';
import {
  workspaceExecutionAdmissionCounters,
  workflowRunActiveAdmissions,
} from './schema/runs/admission.js';
import {
  workspaceExecutionEntitlements,
  workspaceExecutionEntitlementVersions,
} from './schema/runs/entitlements.js';
export {
  authAccounts,
  authSessions,
  authVerifications,
} from './schema/authentication.js';
export {
  users,
  workspaces,
  workspaceMemberships,
  auditEvents,
  usageEvents,
} from './schema/foundation.js';
export { rlsProbeRecords } from './schema/rls-probe.js';
export {
  artifacts,
  outboxEvents,
  inboxReceipts,
  transportSecurityAuditFacts,
} from './schema/transport.js';
export {
  workflowRuns,
  runEvents,
  runCheckpoints,
  nodeRuns,
  nodeAttempts,
  previewRuns,
  previewAttempts,
} from './schema/runs/execution.js';
export {
  artifactLinks,
  idempotencyRecords,
  workspaceCreationIdempotencyRecords,
} from './schema/runs/support.js';
export {
  workflows,
  workflowDrafts,
  workflowVersions,
  workflowTriggers,
} from './schema/authoring/workflows.js';
export { workflowIntegrationUsage } from './schema/authoring/integrations.js';
export {
  webhookTriggerSecretVersions,
  webhookTriggerEndpoints,
  webhookTriggerDeliveries,
  webhookTriggerReplayRecords,
  triggerSchedules,
  triggerScheduleOccurrences,
} from './schema/triggers.js';

export const databaseSchema = {
  workflowFolders,
  workflowTags,
  workflowOrganizationState,
  workflowTagAssignments,
  workflowFavorites,
  nodeAttemptConnectionDispatches,
  connectionHealthObservations,
  userProfileCommandReceipts,
  authMethodLinkAttempts,
  authEmailProofs,
  authenticationMailDeliveries,
  identitySecurityAuditFacts,
  failureNotificationDestinations,
  failureNotificationDestinationVersions,
  workflowFailureNotificationPolicies,
  runFailureNotificationIntents,
  runFailureNotificationAuditFacts,
  operatorCommands,
  operatorRunReplayRequests,
  operatorUnknownOutcomeEvidence,
  outboxFairDispatchCursor,
  workspaceExecutionEntitlements,
  workspaceExecutionEntitlementVersions,
  workspaceExecutionAdmissionCounters,
  workflowRunActiveAdmissions,
  workspaceLifecycleOperations,
  workflowTemplateOrigins,
  workflowManualStartRejections,
  workflowInputCases,
  workflowInputCasePayloads,
  workflowConcurrencyPolicies,
  artifactLinks,
  artifacts,
  workspaceArtifactCapacity,
  auditEvents,
  authAccounts,
  authSessions,
  authVerifications,
  connectionEvents,
  connections,
  connectionSecretVersions,
  idempotencyRecords,
  inboxReceipts,
  nodeAttempts,
  nodeRuns,
  outboxEvents,
  previewAttempts,
  previewRuns,
  rlsProbeRecords,
  runCheckpoints,
  runEvents,
  transportSecurityAuditFacts,
  triggerScheduleOccurrences,
  triggerSchedules,
  usageEvents,
  users,
  workspaceMemberships,
  workspaceInboxEvents,
  workspaceInboxReads,
  workspaceInboxThreads,
  workflowFailureStreaks,
  workflowTriggerOutcomes,
  workflowTriggerPausePeriods,
  workspaceInvitations,
  workspaceInvitationDeliveryAttempts,
  workspaceInvitationAcceptanceIntents,
  workspaceInvitationBindingReplacementClaims,
  workspaces,
  workflowDrafts,
  workflowIntegrationUsage,
  workflowTriggers,
  webhookTriggerDeliveries,
  webhookEndpointIngressLimits,
  webhookTriggerEndpoints,
  webhookTriggerReplayRecords,
  webhookTriggerSecretVersions,
  workflowVersions,
  workflows,
  workflowRuns,
  workspaceCreationIdempotencyRecords,
};
