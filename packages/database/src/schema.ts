import {
  users,
  authIdentities,
  sessions,
  oidcLoginTransactions,
  workspaces,
  workspaceMemberships,
  auditEvents,
  usageEvents,
  rlsProbeRecords,
} from './schema/foundation.js';
import {
  workspaceControlLedgerProjection,
  workspaceLegalHolds,
  retentionControlAuditFacts,
  retentionBatches,
  retentionScheduleState,
} from './schema/retention.js';
import {
  connections,
  connectionSecretVersions,
  connectionEvents,
} from './schema/connections.js';
import {
  artifacts,
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
  webhookTriggerSecretVersions,
  webhookTriggerEndpoints,
  webhookTriggerDeliveries,
  webhookEndpointIngressLimits,
  webhookTriggerReplayRecords,
  triggerSchedules,
  triggerScheduleOccurrences,
} from './schema/triggers.js';
import {
  nodeCompatibilityReleases,
  nodeCompatibilityPreactivationChecks,
  nodeCompatibilityActivationApprovals,
  nodeCompatibilityCurrent,
  nodeCompatibilityActivations,
} from './schema/compatibility.js';

export {
  users,
  authIdentities,
  sessions,
  workspaces,
  workspaceMemberships,
  auditEvents,
  usageEvents,
  rlsProbeRecords,
} from './schema/foundation.js';
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
export {
  nodeCompatibilityReleases,
  nodeCompatibilityCurrent,
} from './schema/compatibility.js';

export const databaseSchema = {
  artifacts,
  auditEvents,
  authIdentities,
  connectionEvents,
  connections,
  connectionSecretVersions,
  idempotencyRecords,
  inboxReceipts,
  nodeAttempts,
  nodeCompatibilityCurrent,
  nodeCompatibilityActivationApprovals,
  nodeCompatibilityActivations,
  nodeCompatibilityPreactivationChecks,
  nodeCompatibilityReleases,
  nodeRuns,
  oidcLoginTransactions,
  outboxEvents,
  previewAttempts,
  previewRuns,
  retentionBatches,
  retentionControlAuditFacts,
  retentionScheduleState,
  workspaceControlLedgerProjection,
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
