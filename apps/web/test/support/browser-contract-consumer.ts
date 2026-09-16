import { artifactMetadataResponseSchema } from '@pertexo/contracts/schemas/artifacts';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts/schemas/catalog';
import { connectionListResponseSchema } from '@pertexo/contracts/schemas/connections';
import { apiProblemSchema } from '@pertexo/contracts/schemas/errors';
import { accessibleWorkspacesResponseSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { nodeValidationResponseSchema } from '@pertexo/contracts/schemas/node-testing';
import { failureNotificationDestinationListResponseSchema } from '@pertexo/contracts/schemas/failure-notifications';
import { scheduleTriggerListResponseSchema } from '@pertexo/contracts/schemas/schedules';
import { workflowListResponseSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { workflowRunResponseSchema } from '@pertexo/contracts/schemas/workflow-runs';
import { webhookTriggerListResponseSchema } from '@pertexo/contracts/schemas/webhooks';

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
  webhooks: webhookTriggerListResponseSchema,
});
