import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  workflowIntegrationUsage,
  type WorkflowDefinitionCatalogV1,
} from '@pertexo/workflow-model/graph';
import { workflowCallStructuralProjectionV1 } from '@pertexo/workflow-model/workflow-call-closure';
import type { PublishWorkflowInput } from './workflow-authoring-contracts.js';
import type { WorkflowVersionRecord } from './workflow-authoring-records.js';
import type { WorkflowAuthoringTestHooks } from './workflow-authoring-types.js';
import { persistPublishedWorkflowTriggers } from './workflow-trigger-reconciliation.js';

const uuidSchema = z.uuid();
const providerKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const operationKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
export async function persistPublicationProjections(
  client: PoolClient,
  input: PublishWorkflowInput,
  workflowId: string,
  definitionCatalog: WorkflowDefinitionCatalogV1,
  version: WorkflowVersionRecord,
  hooks: WorkflowAuthoringTestHooks | undefined,
): Promise<void> {
  const usage = workflowIntegrationUsage(
    version.schemaVersion === 2
      ? workflowCallStructuralProjectionV1(version.graphJson)
      : version.graphJson,
    definitionCatalog,
  ).map((item) => ({
    connection_id: uuidSchema.parse(item.connectionId),
    operation_key: operationKeySchema.parse(item.operationKey),
    provider_key: providerKeySchema.parse(item.providerKey),
  }));
  await client.query(
    `delete from app.workflow_integration_usage
     where workspace_id=$1 and workflow_version_id=$2`,
    [input.workspaceId, version.id],
  );
  if (usage.length > 0)
    await client.query(
      `insert into app.workflow_integration_usage
         (workspace_id,workflow_version_id,provider_key,operation_key,connection_id)
       select $1,$2,item.provider_key,item.operation_key,item.connection_id
       from jsonb_to_recordset($3::jsonb) as item(
         provider_key varchar(64),operation_key varchar(128),connection_id uuid)`,
      [input.workspaceId, version.id, JSON.stringify(usage)],
    );
  await hooks?.afterPublishStep?.('integration_usage');
  await persistPublishedWorkflowTriggers(client, {
    workspaceId: input.workspaceId,
    workflowId,
    version,
  });
  await hooks?.afterPublishStep?.('trigger_projection');
}
