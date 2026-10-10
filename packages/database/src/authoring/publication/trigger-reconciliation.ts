import { z } from 'zod';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { workflowTriggerProjection } from '../../triggers/reconciliation/projection.js';
import type { WorkflowVersionRecord } from '../workflows/representation/records.js';

const uuidSchema = z.uuid();
const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16));

export function reconcileWorkflowTriggersPayload(
  input: Readonly<{
    outboxEventId: string;
    publishedVersionId: string;
    traceparent?: string;
    workflowId: string;
    workspaceId: string;
  }>,
): Record<string, unknown> {
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: uuidSchema.parse(input.workspaceId),
    outboxEventId: uuidSchema.parse(input.outboxEventId),
    workflowId: uuidSchema.parse(input.workflowId),
    publishedVersionId: uuidSchema.parse(input.publishedVersionId),
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: traceparentSchema.parse(input.traceparent) }),
  });
}

/** Materializes the desired triggers for one published immutable version. */
export async function persistPublishedWorkflowTriggers(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    version: WorkflowVersionRecord;
  }>,
): Promise<void> {
  const { workflowId, version } = input;
  const triggers = workflowTriggerProjection(version.graphJson);
  await client.query(
    `delete from app.workflow_triggers
     where workspace_id=$1 and workflow_version_id=$2
       and not (node_id=any($3::varchar[]))`,
    [input.workspaceId, version.id, triggers.map(({ nodeId }) => nodeId)],
  );
  if (triggers.length > 0) {
    const projection = triggers.map((trigger) => ({
      id: generatePersistedId(),
      node_id: trigger.nodeId,
      kind: trigger.kind,
      desired_config: trigger.config,
      config_fingerprint: trigger.configFingerprint,
    }));
    await client.query(
      `insert into app.workflow_triggers (
         id,workspace_id,workflow_id,workflow_version_id,node_id,kind,
         desired_config,config_fingerprint,status)
       select item.id,$1,$2,$3,item.node_id,item.kind,item.desired_config,
         item.config_fingerprint,'desired'
       from jsonb_to_recordset($4::jsonb) as item(
         id uuid,node_id varchar(128),kind varchar(16),desired_config jsonb,
         config_fingerprint varchar(82))
       on conflict (workflow_version_id,node_id) do update set
         desired_config=excluded.desired_config,
         config_fingerprint=excluded.config_fingerprint
       where app.workflow_triggers.workspace_id=excluded.workspace_id
         and app.workflow_triggers.workflow_id=excluded.workflow_id
         and app.workflow_triggers.kind=excluded.kind`,
      [input.workspaceId, workflowId, version.id, JSON.stringify(projection)],
    );
  }
}
