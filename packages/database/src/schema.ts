import { workflowPublicationRequests } from './schema/authoring/publication-requests.js';
import { authSignInAttempts } from './schema/identity/sign-in.js';
import {
  triggerEventWindows,
  triggerCoordinatedEvents,
} from './schema/event-coordination/records.js';
import {
  workspaceDataTableQuotas,
  workspaceDataTables,
  workspaceDataTableRows,
  dataTableWriteReceipts,
} from './schema/data-tables.js';
import {
  workflowTestSuites,
  workflowTestSuiteCases,
} from './schema/runs/suites.js';
import { workflowTestSnapshots } from './schema/runs/tests.js';
import { webhookRunResponses } from './schema/triggers/responses.js';
export { workflowStepSamples } from './schema/authoring/step-samples.js';
import { workflowStepSamples } from './schema/authoring/step-samples.js';
import { systemMailDeliveries } from './schema/mail/deliveries.js';
import {
  noticeWorkspaceSettings,
  noticePreferences,
  noticeSubscriptions,
} from './schema/inbox/preferences.js';
import { noticeMailBatches, noticeMailItems } from './schema/inbox/mail.js';
import {
  workspaceVariables,
  workspaceVariableSetRevisions,
} from './schema/variables.js';
import { workflowForms } from './schema/triggers/forms.js';
import { pendingRunTasks } from './schema/runs/pending-task.js';
import { workflowErrorPolicies } from './schema/authoring/error-workflow.js';
import { runErrorWorkflowIntents } from './schema/runs/completion/error-workflow.js';
import { apiTokens } from './schema/identity/api-tokens.js';
import {
  authAccounts,
  authSessions,
  authVerifications,
  userProfileCommandReceipts,
  authMethodLinkAttempts,
  authEmailProofs,
  identitySecurityAuditFacts,
} from './schema/authentication.js';
import { workflowTemplateOrigins } from './schema/authoring/template-origin.js';
import { workflowVersionDependencies } from './schema/authoring/dependencies.js';
import { workflowCalls } from './schema/runs/calls.js';
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
} from './schema/inbox/core.js';
import {
  workflowFailureStreaks,
  workflowTriggerOutcomes,
  workflowTriggerPausePeriods,
} from './schema/trigger-pause.js';
import {
  webhookTriggerSecretVersions,
  webhookTriggerEndpoints,
} from './schema/triggers/endpoints.js';
import {
  webhookTriggerDeliveries,
  webhookEndpointIngressLimits,
  webhookTriggerReplayRecords,
} from './schema/triggers/deliveries.js';
import {
  triggerSchedules,
  triggerScheduleOccurrences,
} from './schema/triggers/schedules.js';

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
} from './schema/runs/completion/notifications.js';
import {
  operatorCommands,
  operatorRunReplayRequests,
  operatorUnknownOutcomeEvidence,
} from './schema/runs/operator.js';
import {
  workspaceExecutionAdmissionCounters,
  workflowRunActiveAdmissions,
} from './schema/runs/capacity/admission.js';
import {
  workspaceExecutionEntitlements,
  workspaceExecutionEntitlementVersions,
} from './schema/runs/capacity/entitlements.js';
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
export { workspaceVariableSetRevisions } from './schema/variables.js';
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
} from './schema/triggers/endpoints.js';
export {
  webhookTriggerDeliveries,
  webhookTriggerReplayRecords,
} from './schema/triggers/deliveries.js';
export {
  triggerSchedules,
  triggerScheduleOccurrences,
} from './schema/triggers/schedules.js';

export const databaseSchema = {
  workflowPublicationRequests,
  triggerEventWindows,
  triggerCoordinatedEvents,
  workspaceDataTableQuotas,
  workspaceDataTables,
  workspaceDataTableRows,
  dataTableWriteReceipts,
  workflowTestSuites,
  workflowTestSuiteCases,
  workflowTestSnapshots,
  webhookRunResponses,
  workflowStepSamples,
  noticeWorkspaceSettings,
  noticePreferences,
  noticeSubscriptions,
  noticeMailBatches,
  noticeMailItems,
  workspaceVariables,
  workspaceVariableSetRevisions,
  workflowForms,
  pendingRunTasks,
  workflowErrorPolicies,
  runErrorWorkflowIntents,
  apiTokens,
  workflowVersionDependencies,
  workflowCalls,
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
  systemMailDeliveries,
  authSignInAttempts,
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
