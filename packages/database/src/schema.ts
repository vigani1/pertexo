import {
  authAccounts,
  authSessions,
  authVerifications,
  authIdentities,
  sessions,
  oidcLoginTransactions,
} from './schema/authentication.js';
import { workflowTemplateOrigins } from './schema/curated-template-origin.js';
import { workflowManualStartRejections } from './schema/manual-start.js';
import {
  workflowInputCases,
  workflowInputCasePayloads,
} from './schema/workflow-input-cases.js';
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
} from './schema/foundation.js';
import { rlsProbeRecords } from './schema/rls-probe.js';
import { workflowConcurrencyPolicies } from './schema/workflow-concurrency.js';
import { workspaceLegalHolds } from './schema/retention.js';
import {
  connections,
  connectionSecretVersions,
  connectionEvents,
} from './schema/connections.js';
import {
  artifacts,
  workspaceArtifactCapacity,
  outboxEvents,
  inboxReceipts,
  transportSecurityAuditFacts,
} from './schema/transport.js';
import {
  workflowRuns,
  runEvents,
  runCheckpoints,
  nodeRuns,
  nodeAttempts,
  previewRuns,
  previewAttempts,
} from './schema/execution.js';
import {
  artifactLinks,
  idempotencyRecords,
  workspaceCreationIdempotencyRecords,
} from './schema/execution-support.js';
import {
  workflows,
  workflowDrafts,
  workflowVersions,
  workflowIntegrationUsage,
  workflowTriggers,
} from './schema/authoring.js';
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

export {
  authAccounts,
  authSessions,
  authVerifications,
  authIdentities,
  sessions,
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
} from './schema/execution.js';
export {
  artifactLinks,
  idempotencyRecords,
  workspaceCreationIdempotencyRecords,
} from './schema/execution-support.js';
export {
  workflows,
  workflowDrafts,
  workflowVersions,
  workflowIntegrationUsage,
  workflowTriggers,
} from './schema/authoring.js';
export {
  webhookTriggerSecretVersions,
  webhookTriggerEndpoints,
  webhookTriggerDeliveries,
  webhookTriggerReplayRecords,
  triggerSchedules,
  triggerScheduleOccurrences,
} from './schema/triggers.js';

export const databaseSchema = {
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
  authIdentities,
  authSessions,
  authVerifications,
  connectionEvents,
  connections,
  connectionSecretVersions,
  idempotencyRecords,
  inboxReceipts,
  nodeAttempts,
  nodeRuns,
  oidcLoginTransactions,
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
  sessions,
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
  workspaceLegalHolds,
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
