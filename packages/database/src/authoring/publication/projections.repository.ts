import { revokeRemovedFormAccess } from '../../triggers/forms/publication.repository.js';

import { generatePersistedId } from '../../platform/persisted-id.js';

import { workflowIntegrationUsage } from '@pertexo/workflow-model/server';

import type { PoolClient } from 'pg';

import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';

import type { WorkflowVersionRecord } from '../workflows/representation/contract.js';

import {
  reconcileWorkflowTriggersPayload,
  persistPublishedWorkflowTriggers,
} from './trigger-reconciliation.repository.js';
import { persistPublicationCalls } from './calls.repository.js';

import {
  uuidSchema,
  providerKeySchema,
  operationKeySchema,
  type PublicationCandidateInput,
  type CompiledPublication,
} from './contract.js';

export async function persistPublicationProjections(
  client: PoolClient,
  input: PublicationCandidateInput,
  {
    workflowId,
    publication,
    version,
  }: Readonly<{
    workflowId: string;
    publication: CompiledPublication;
    version: WorkflowVersionRecord;
  }>,
): Promise<void> {
  await revokeRemovedFormAccess(
    client,
    input.workspaceId,
    workflowId,
    publication.graph,
  );
  const usage = workflowIntegrationUsage(
    version.graphJson,
    publication.definitionCatalog,
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
  await persistPublicationCalls(
    client,
    input.workspaceId,
    version.id,
    publication.calls,
  );
  await persistPublishedWorkflowTriggers(client, {
    workspaceId: input.workspaceId,
    workflowId,
    version,
  });
}

export async function finalizePublication(
  client: PoolClient,
  input: PublicationCandidateInput,
  {
    workflowId,
    version,
    reused,
  }: Readonly<{
    workflowId: string;
    version: WorkflowVersionRecord;
    reused: boolean;
  }>,
): Promise<void> {
  await client.query(
    `update app.workflows set published_version_id=$1,
       activation_status='activating',updated_at=transaction_timestamp()
     where workspace_id=$2 and id=$3`,
    [version.id, input.workspaceId, workflowId],
  );
  const eventId = generatePersistedId();
  const payload = reconcileWorkflowTriggersPayload({
    workspaceId: input.workspaceId,
    outboxEventId: eventId,
    workflowId,
    publishedVersionId: version.id,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  });
  await client.query(
    `insert into app.outbox_events
       (id,workspace_id,job_name,aggregate_type,aggregate_id,
        payload,payload_checksum)
     values($1,$2,'reconcile-workflow-triggers','workflow',$3,$4::jsonb,$5)`,
    [
      eventId,
      input.workspaceId,
      workflowId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
  await client.query(
    `insert into app.audit_events
       (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,
        trace_id,metadata)
     values($1,$2,$3,'workflow.published','workflow',$4,$5,$6,$7::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorId,
      workflowId,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify({
        checksum: version.checksum,
        reused,
        versionId: version.id,
        versionNumber: version.versionNumber,
      }),
    ],
  );
}
