import {
  actorId,
  authoring,
  currentRepresentationTag,
  emptyGraph,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../../support/workflow-authoring.js';

export async function source(
  database = authoring,
  graph: unknown = emptyGraph,
) {
  return database.createWorkflow({
    actorId,
    workspaceId,
    emptyGraph: graph,
    name: 'Duplication source',
    idempotencyKey: `duplicate-source-${randomUUID()}`,
  });
}

export async function command(workflowId: string, database = authoring) {
  return {
    actorId,
    workspaceId,
    workflowId,
    name: 'Independent copy',
    source: { kind: 'draft' as const },
    idempotencyKey: `duplicate-${randomUUID()}`,
    representationTag: await currentRepresentationTag(database, workspaceId, {
      scopedWorkflowId: workflowId,
      scopedActorId: actorId,
    }),
  };
}

export async function facts(workflowId: string) {
  const rows = await queryAsOwner<{
    workflow: Record<string, unknown>;
    graph: unknown;
    revision: number;
    versions: number;
    runs: number;
    triggers: number;
    outbox: number;
    concurrency: number;
    notifications: number;
    streaks: number;
    receipts: number;
  }>(
    `select to_jsonb(w) workflow,d.graph_json graph,d.revision,
    (select count(*)::int from app.workflow_versions where workflow_id=w.id) versions,
    (select count(*)::int from app.workflow_runs where workflow_id=w.id) runs,
    (select count(*)::int from app.workflow_triggers where workflow_id=w.id) triggers,
    (select count(*)::int from app.outbox_events where aggregate_id=w.id) outbox,
    (select count(*)::int from app.workflow_concurrency_policies where workflow_id=w.id) concurrency,
    (select count(*)::int from app.workflow_failure_notification_policies where workflow_id=w.id) notifications,
    (select count(*)::int from app.workflow_failure_streaks where workflow_id=w.id) streaks,
    (select count(*)::int from app.idempotency_records where resource_id=w.id and operation='workflow.duplicate') receipts
    from app.workflows w join app.workflow_drafts d on d.workspace_id=w.workspace_id and d.workflow_id=w.id
    where w.id=$1`,
    [workflowId],
    workspaceId,
  );
  const row = rows[0];
  if (!row) throw new Error('Expected destination facts');
  return row;
}

export async function commandFacts() {
  return queryAsOwner(
    `select
    (select count(*)::int from app.workflows where workspace_id=$1) workflows,
    (select count(*)::int from app.workflow_drafts where workspace_id=$1) drafts,
    (select count(*)::int from app.idempotency_records where workspace_id=$1 and operation='workflow.duplicate') receipts,
    (select count(*)::int from app.audit_events where workspace_id=$1 and action='workflow.duplicated') audits,
    (select count(*)::int from app.outbox_events where workspace_id=$1) outbox`,
    [workspaceId],
    workspaceId,
  );
}
