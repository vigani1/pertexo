import {
  workspaceId,
  queryAsOwner,
} from '../../../support/workflow-authoring.js';

export async function publicationFacts(scopedWorkflowId: string) {
  const rows = await queryAsOwner<{
    audits: number;
    commands: number;
    outbox: number;
    pointer: string | null;
    triggers: unknown;
    usage: unknown;
    versions: unknown;
  }>(
    `select workflow.published_version_id::text pointer,
            (select jsonb_agg(version.id order by version.version_number)
               from app.workflow_versions version
              where version.workflow_id=workflow.id) versions,
            (select jsonb_agg(jsonb_build_object(
                       'connectionId',usage.connection_id,
                       'operationKey',usage.operation_key,
                       'providerKey',usage.provider_key)
                     order by usage.provider_key,usage.operation_key,usage.connection_id)
               from app.workflow_integration_usage usage
               join app.workflow_versions version
                 on version.id=usage.workflow_version_id
              where version.workflow_id=workflow.id) usage,
            (select jsonb_agg(jsonb_build_object(
                       'id',trigger.id,'kind',trigger.kind,
                       'nodeId',trigger.node_id,
                       'fingerprint',trigger.config_fingerprint)
                     order by trigger.node_id)
               from app.workflow_triggers trigger
              where trigger.workflow_id=workflow.id) triggers,
            (select count(*)::int from app.audit_events
              where target_id=workflow.id and action='workflow.published') audits,
            (select count(*)::int from app.outbox_events
              where aggregate_id=workflow.id) outbox,
            (select count(*)::int from app.idempotency_records
              where resource_id=workflow.id and operation='workflow.publish') commands
       from app.workflows workflow where workflow.id=$1`,
    [scopedWorkflowId],
    workspaceId,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('publication facts missing');
  return row;
}
