import {
  artifactMetadataResponseSchema,
  nodeDefinitionListResponseSchema,
  connectionListResponseSchema,
  apiProblemSchema,
  accessibleWorkspacesResponseSchema,
  nodeValidationResponseSchema,
  failureNotificationDestinationListResponseSchema,
  scheduleTriggerListResponseSchema,
  workflowListResponseSchema,
  workflowImportPreviewResponseSchema,
  workflowRunResponseSchema,
  webhookTriggerListResponseSchema,
  workspaceInboxListResponseSchema,
} from '@pertexo/contracts';
import {
  workflowPortableManifestSchema,
  parsePortableJson,
  portableGraphDigest,
} from '@pertexo/workflow-model';

export const browserContractConsumer = Object.freeze({
  artifact: artifactMetadataResponseSchema,
  connections: connectionListResponseSchema,
  failureNotifications: failureNotificationDestinationListResponseSchema,
  nodeDefinitions: nodeDefinitionListResponseSchema,
  nodeValidation: nodeValidationResponseSchema,
  problem: apiProblemSchema,
  schedules: scheduleTriggerListResponseSchema,
  workspaces: accessibleWorkspacesResponseSchema,
  workflows: workflowListResponseSchema,
  workflowRun: workflowRunResponseSchema,
  workflowPortable: workflowPortableManifestSchema,
  workflowPortablePreview: workflowImportPreviewResponseSchema,
  parsePortableJson,
  portableGraphDigest,
  webhooks: webhookTriggerListResponseSchema,
  workspaceInbox: workspaceInboxListResponseSchema,
});
