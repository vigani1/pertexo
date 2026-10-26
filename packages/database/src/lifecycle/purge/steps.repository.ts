import {
  purgeFolderLeaves,
  purgePreviewLeaves,
  purgeOldConnectionSecrets,
  purgeConnections,
  purgeOldDestinationVersions,
  purgeDestinations,
} from './links.repository.js';
import {
  purgeInputPayloads,
  clearCurrentAttempts,
  scrubAuditFacts,
  scrubUsageFacts,
  scrubTransportFacts,
  purgeCreationReceipts,
  clearPublishedVersions,
} from './records.repository.js';
import {
  purgeNoticeMail,
  purgeFederationAttempts,
  purgeProviderSessions,
  purgeProviderAccounts,
  purgeOrganization,
} from './identity.repository.js';
import { workflowFolderGrants } from '../../schema/authoring/folder-grants.js';
import {
  connectionShares,
  connectionHealthObservations,
  nodeAttemptConnectionDispatches,
  connectionEvents,
} from '../../schema/connections.js';
import { noticeMailItems, noticeMailBatches } from '../../schema/inbox/mail.js';
import {
  noticeSubscriptions,
  noticePreferences,
  noticeWorkspaceSettings,
} from '../../schema/inbox/preferences.js';
import { authDirectoryGroupMappings } from '../../schema/identity/federation/directory/mappings.js';
import { authOrganizationWorkspaces } from '../../schema/identity/federation/organizations.js';
import { apiTokens } from '../../schema/identity/api-tokens.js';
import { formUploads, workflowForms } from '../../schema/triggers/forms.js';
import { pendingRunTasks } from '../../schema/runs/pending-task.js';
import { workflowPublicationRequests } from '../../schema/authoring/publication-requests.js';
import { workspacePromotionTargets } from '../../schema/authoring/promotions/targets.js';
import { runErrorWorkflowIntents } from '../../schema/runs/completion/error-workflow.js';
import { workflowErrorPolicies } from '../../schema/authoring/error-workflow.js';
import {
  workflowFavorites,
  workflowTagAssignments,
  workflowOrganizationState,
  workflowTags,
} from '../../schema/authoring/organization.js';
import { workflowInputCases } from '../../schema/authoring/input-cases.js';
import { webhookTestEvents } from '../../schema/triggers/test-events.js';
import { workflowStepSamples } from '../../schema/authoring/step-samples.js';
import { webhookRunResponses } from '../../schema/triggers/responses.js';
import { workflowRunValues } from '../../schema/runs/values.js';
import { workflowPresenceLeases } from '../../schema/authoring/collaboration/presence.js';
import { workflowCommentMentions } from '../../schema/authoring/collaboration/mentions.js';
import { workflowComments } from '../../schema/authoring/collaboration/comments.js';
import { workflowCommentThreads } from '../../schema/authoring/collaboration/threads.js';
import {
  dataTableWriteReceipts,
  workspaceDataTableRows,
  workspaceDataTables,
  workspaceDataTableQuotas,
} from '../../schema/data-tables.js';
import {
  webhookTriggerReplayRecords,
  webhookTriggerDeliveries,
  webhookEndpointIngressLimits,
} from '../../schema/triggers/deliveries.js';
import {
  triggerCoordinatedEvents,
  triggerEventWindows,
} from '../../schema/event-coordination/records.js';
import {
  runFailureNotificationAuditFacts,
  runFailureNotificationIntents,
} from '../../schema/runs/completion/notifications.js';
import {
  workflowRunActiveAdmissions,
  workspaceExecutionAdmissionCounters,
} from '../../schema/runs/capacity/admission.js';
import { workflowCalls } from '../../schema/runs/calls.js';
import {
  operatorUnknownOutcomeEvidence,
  operatorRunReplayRequests,
  operatorCommands,
} from '../../schema/runs/operator.js';
import {
  nodeAttempts,
  nodeRuns,
  runEvents,
  runCheckpoints,
  previewAttempts,
  workflowRuns,
} from '../../schema/runs/execution.js';
import {
  artifactLinks,
  idempotencyRecords,
} from '../../schema/runs/support.js';
import {
  triggerScheduleOccurrences,
  triggerSchedules,
} from '../../schema/triggers/schedules.js';
import {
  webhookTriggerEndpoints,
  webhookTriggerSecretVersions,
} from '../../schema/triggers/endpoints.js';
import {
  workflowTriggers,
  workflowDrafts,
  workflowVersions,
  workflows,
} from '../../schema/authoring/workflows.js';
import { workflowFailureNotificationPolicies } from '../../schema/notifications.js';
import {
  workflowTestSuiteCases,
  workflowTestSuites,
} from '../../schema/runs/suites.js';
import {
  workspaceVariables,
  workspaceVariableSetRevisions,
} from '../../schema/variables.js';
import {
  workspaceInboxReads,
  workspaceInboxThreads,
  workspaceInboxEvents,
} from '../../schema/inbox/core.js';
import { workflowConcurrencyPolicies } from '../../schema/authoring/concurrency.js';
import {
  workflowTriggerPausePeriods,
  workflowFailureStreaks,
  workflowTriggerOutcomes,
} from '../../schema/trigger-pause.js';
import { workflowManualStartRejections } from '../../schema/runs/manual-start.js';
import { workflowTestSnapshots } from '../../schema/runs/tests.js';
import { workflowIntegrationUsage } from '../../schema/authoring/integrations.js';
import { workflowVersionPromotions } from '../../schema/authoring/promotions/versions.js';
import { workflowPromotionOrigins } from '../../schema/authoring/promotions/origins.js';
import {
  artifacts,
  workspaceArtifactCapacity,
  outboxEvents,
  inboxReceipts,
} from '../../schema/transport.js';
import {
  workspaceExecutionEntitlements,
  workspaceExecutionEntitlementVersions,
} from '../../schema/runs/capacity/entitlements.js';
import {
  workspaceLifecycleOperations,
  workspaceInvitationAcceptanceIntents,
  workspaceInvitationDeliveryAttempts,
  workspaceInvitations,
  workspaceMemberships,
} from '../../schema/foundation.js';
import { rlsProbeRecords } from '../../schema/rls-probe.js';
import { workflowVersionDependencies } from '../../schema/authoring/dependencies.js';
import { workflowTemplateOrigins } from '../../schema/authoring/template-origin.js';
import { purgeDirectoryMemberships } from '../identity/directory.repository.js';
import { reapInvitationReplacementClaims } from '../invitations/claims.repository.js';

import type { PurgeStep } from './contract.js';
import { deleteRows } from './rows.repository.js';

/**
 * Tables a purge keeps after scrubbing what identifies people or requests:
 * the workspace tombstone, audit and usage facts, and transport security facts.
 */
export const PURGE_PRESERVED_TABLES = Object.freeze([
  'workspaces',
  'audit_events',
  'usage_events',
  'transport_security_audit_facts',
]);

/**
 * Everything a purge removes, in dependency order. Each step changes at most
 * one page; a later step runs only once every earlier one has nothing left.
 */
export const PURGE_STEPS: readonly PurgeStep[] = Object.freeze([
  deleteRows(workflowFolderGrants),
  deleteRows(connectionShares),
  {
    name: 'personal_notice_mail',
    run: purgeNoticeMail,
  },
  ...[
    noticeMailItems,
    noticeMailBatches,
    noticeSubscriptions,
    noticePreferences,
    noticeWorkspaceSettings,
  ].map(deleteRows),
  { name: 'auth_directory_memberships', run: purgeDirectoryMemberships },
  deleteRows(authDirectoryGroupMappings),
  {
    name: 'identity_federation_attempts',
    run: purgeFederationAttempts,
  },
  {
    name: 'identity_provider_sessions',
    run: purgeProviderSessions,
  },
  {
    name: 'identity_provider_accounts',
    run: purgeProviderAccounts,
  },
  {
    name: 'identity_organization',
    run: purgeOrganization,
  },
  deleteRows(authOrganizationWorkspaces),
  deleteRows(apiTokens),
  deleteRows(workflowForms),
  deleteRows(pendingRunTasks),
  deleteRows(workflowPublicationRequests),
  deleteRows(workspacePromotionTargets),
  deleteRows(runErrorWorkflowIntents),
  deleteRows(workflowErrorPolicies),
  // Workflow organization.
  ...[workflowFavorites, workflowTagAssignments, workflowOrganizationState].map(
    deleteRows,
  ),
  {
    // Folders nest; leaves go first.
    name: 'workflow_folders',
    run: purgeFolderLeaves,
  },
  deleteRows(workflowTags),
  {
    // Payloads are large; a page stays under 1 MiB.
    name: 'workflow_input_case_payloads',
    run: purgeInputPayloads,
  },
  deleteRows(workflowInputCases),
  deleteRows(webhookTestEvents),
  deleteRows(workflowStepSamples),
  deleteRows(webhookRunResponses),
  deleteRows(workflowRunValues),
  {
    // A node run points at its current attempt; clear it before attempts go.
    name: 'node_run_current_attempts',
    run: clearCurrentAttempts,
  },
  {
    // Audit and usage facts stay as anonymous counts.
    name: 'audit_events_scrubbed',
    run: scrubAuditFacts,
  },
  {
    name: 'usage_events_scrubbed',
    run: scrubUsageFacts,
  },
  {
    name: 'transport_security_audit_facts_scrubbed',
    run: scrubTransportFacts,
  },
  {
    // Workspace creation is idempotent on the created workspace's id.
    name: 'workspace_creation_idempotency_records',
    run: purgeCreationReceipts,
  },
  {
    name: 'workspace_invitation_binding_replacement_claims',
    run: (client, workspaceId, pageSize) =>
      reapInvitationReplacementClaims(client, pageSize, workspaceId),
  },
  ...[
    workflowPresenceLeases,
    workflowCommentMentions,
    workflowComments,
    workflowCommentThreads,
    dataTableWriteReceipts,
    workspaceDataTableRows,
    workspaceDataTables,
    workspaceDataTableQuotas,
    webhookTriggerReplayRecords,
    webhookTriggerDeliveries,
    triggerCoordinatedEvents,
    triggerEventWindows,
    runFailureNotificationAuditFacts,
    runFailureNotificationIntents,
    workflowRunActiveAdmissions,
    workflowCalls,
    connectionHealthObservations,
    nodeAttemptConnectionDispatches,
    operatorUnknownOutcomeEvidence,
    operatorRunReplayRequests,
    operatorCommands,
    nodeAttempts,
    nodeRuns,
    runEvents,
    runCheckpoints,
    artifactLinks,
    previewAttempts,
    webhookEndpointIngressLimits,
    triggerScheduleOccurrences,
    triggerSchedules,
    webhookTriggerEndpoints,
    webhookTriggerSecretVersions,
    workflowTriggers,
    workflowFailureNotificationPolicies,
    workflowTestSuiteCases,
    workflowTestSuites,
    workspaceVariables,
    workspaceInboxReads,
    workspaceInboxThreads,
    workspaceInboxEvents,
    workflowConcurrencyPolicies,
    workflowTriggerPausePeriods,
    workflowFailureStreaks,
    workflowTriggerOutcomes,
    workflowManualStartRejections,
    workflowTestSnapshots,
    workflowRuns,
    workflowIntegrationUsage,
    workflowVersionPromotions,
    workflowPromotionOrigins,
    workflowDrafts,
    connectionEvents,
    formUploads,
    artifacts,
    workspaceArtifactCapacity,
    outboxEvents,
    inboxReceipts,
    idempotencyRecords,
    workspaceExecutionEntitlements,
    workspaceExecutionEntitlementVersions,
    workspaceExecutionAdmissionCounters,
    workspaceLifecycleOperations,
    workspaceInvitationAcceptanceIntents,
    workspaceInvitationDeliveryAttempts,
    workspaceInvitations,
    workspaceMemberships,
    rlsProbeRecords,
  ].map(deleteRows),
  {
    // Previews chain to their prior preview; leaves go first.
    name: 'preview_runs',
    run: purgePreviewLeaves,
  },
  deleteRows(workspaceVariableSetRevisions),
  {
    // A workflow points at its published version; clear it before versions go.
    name: 'workflow_published_versions',
    run: clearPublishedVersions,
  },
  deleteRows(workflowVersionDependencies),
  deleteRows(workflowVersions),
  deleteRows(workflowTemplateOrigins),
  deleteRows(workflows),
  {
    // A connection points at its current secret, so the two go together.
    name: 'connection_secret_versions',
    run: purgeOldConnectionSecrets,
  },
  {
    name: 'connections',
    run: purgeConnections,
  },
  {
    // A destination points at its current version, so the two go together.
    name: 'failure_notification_destination_versions',
    run: purgeOldDestinationVersions,
  },
  {
    name: 'failure_notification_destinations',
    run: purgeDestinations,
  },
]);
