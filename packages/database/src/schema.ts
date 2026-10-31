import { workflowFolderGrants } from './schema/authoring/folder-grants.js';
import { workflowRunValues } from './schema/runs/values.js';
export { workflowRunValues } from './schema/runs/values.js';
import { workflowCommentThreads } from './schema/authoring/collaboration/threads.js';
import { workflowComments } from './schema/authoring/collaboration/comments.js';
import { workflowCommentMentions } from './schema/authoring/collaboration/mentions.js';
import { workflowPresenceLeases } from './schema/authoring/collaboration/presence.js';
import { workspacePromotionTargets } from './schema/authoring/promotions/targets.js';
import { workflowPromotionOrigins } from './schema/authoring/promotions/origins.js';
import { workflowVersionPromotions } from './schema/authoring/promotions/versions.js';
import { authDirectoryUsers } from './schema/identity/federation/directory/users.js';
import { authDirectoryGroups } from './schema/identity/federation/directory/groups.js';
import { authDirectoryGroupMembers } from './schema/identity/federation/directory/members.js';
import { authDirectoryGroupMappings } from './schema/identity/federation/directory/mappings.js';
import { authDirectoryMemberships } from './schema/identity/federation/directory/sources.js';
import { authProvisioningCredentials } from './schema/identity/federation/directory/credentials.js';
import {
  authOrganizations,
  authOrganizationWorkspaces,
} from './schema/identity/federation/organizations.js';
import { authDomains } from './schema/identity/federation/domains.js';
import {
  authProviders,
  authProviderChecks,
} from './schema/identity/federation/providers.js';
import { authFederationAttempts } from './schema/identity/federation/journeys.js';
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
import { webhookTestEvents } from './schema/triggers/test-events.js';
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
import { formUploads, workflowForms } from './schema/triggers/forms.js';
import { pendingRunTasks } from './schema/runs/pending-task.js';
import { workflowErrorPolicies } from './schema/authoring/error-workflow.js';
import { runErrorWorkflowIntents } from './schema/runs/completion/error-workflow.js';
import { apiTokens } from './schema/identity/api-tokens.js';
import {
  authAccounts,
  authTwoFactors,
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
  connectionShares,
  connections,
  connectionSecretVersions,
  connectionEvents,
  nodeAttemptConnectionDispatches,
  connectionHealthObservations,
} from './schema/connections.js';
import {
  connectionOAuth2Authorizations,
  connectionOAuth2Clients,
  connectionOAuth2Tokens,
} from './schema/oauth2-connections.js';
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
  instanceCapacity,
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
  workflowFolderGrants,
  workflowRunValues,
  workflowCommentThreads,
  workflowComments,
  workflowCommentMentions,
  workflowPresenceLeases,

  workspacePromotionTargets,
  workflowPromotionOrigins,
  workflowVersionPromotions,
  authDirectoryUsers,
  authDirectoryGroups,
  authDirectoryGroupMembers,
  authDirectoryGroupMappings,
  authDirectoryMemberships,
  authProvisioningCredentials,
  authOrganizations,
  authOrganizationWorkspaces,
  authDomains,
  authProviders,
  authProviderChecks,
  authFederationAttempts,
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
  webhookTestEvents,
  workflowStepSamples,
  noticeWorkspaceSettings,
  noticePreferences,
  noticeSubscriptions,
  noticeMailBatches,
  noticeMailItems,
  workspaceVariables,
  workspaceVariableSetRevisions,
  workflowForms,
  formUploads,
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
  instanceCapacity,
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
  authTwoFactors,
  authSessions,
  authVerifications,
  connectionEvents,
  connectionOAuth2Authorizations,
  connectionOAuth2Clients,
  connectionOAuth2Tokens,
  connectionShares,
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
