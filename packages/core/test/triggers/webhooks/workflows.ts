import { randomUUID } from 'node:crypto';

import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';

import { webhook, authoring, ownerQuery } from './base.js';
import {
  actorId,
  workspaceId,
  notificationDestinationId,
  hash,
  secret,
  triggerCatalog,
  triggerGraph,
} from './context.js';
import { workflowTriggerIds, deliverReconciliation } from './reconciliation.js';

export async function publishTriggerWorkflow(
  graphDisabled = false,
  responseConfig: Record<string, unknown> = {},
) {
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId,
    name: 'Published trigger projection',
    emptyGraph: { settings: {}, nodes: [], edges: [] },
    idempotencyKey: randomUUID(),
  });
  const graph = triggerGraph(15, graphDisabled);
  const webhookNode = graph.nodes.find(
    (node) => node.definition.key === 'core.webhook',
  );
  if (webhookNode === undefined) throw new Error('Webhook fixture missing');
  webhookNode.config = responseConfig;
  const draft = await authoring.saveDraft({
    actorId,
    workspaceId,
    workflowId: created.workflowId,
    representationTag: workflowDraftRepresentationTag({
      workflowId: created.workflowId,
      revision: created.draft.revision,
      graph: created.draft.graphJson,
      compatibilityFingerprint: created.draft.compatibility.fingerprint,
    }),
    expectedRevision: 1,
    graphJson: graph,
  });
  const representationTag = workflowDraftRepresentationTag({
    workflowId: created.workflowId,
    revision: draft.revision,
    graph: draft.graphJson,
    compatibilityFingerprint: workflowCompatibilityReport(
      draft.graphJson,
      triggerCatalog,
    ).fingerprint,
  });
  const published = await authoring.publishWorkflow({
    actorId,
    workspaceId,
    workflowId: created.workflowId,
    representationTag,
    idempotencyKey: randomUUID(),
    requestHash: hash('publish-trigger-projection'),
  });
  const event = await ownerQuery<{ id: string }>(
    `select id from app.outbox_events where aggregate_id=$1
      and job_name='reconcile-workflow-triggers'`,
    [created.workflowId],
  );
  const eventId = event.rows[0]?.id;
  if (eventId === undefined) throw new Error('Reconciliation event missing');
  return {
    created,
    eventChecksum: await ownerQuery<{ payload_checksum: string }>(
      'select payload_checksum from app.outbox_events where id=$1',
      [eventId],
    ).then((result) => {
      const checksum = result.rows[0]?.payload_checksum;
      if (checksum === undefined)
        throw new Error('Reconciliation checksum missing');
      return checksum;
    }),
    eventId,
    published,
  };
}

export async function publishNextTriggerWorkflowVersion(
  workflowIdInput: string,
) {
  const currentDraft = await authoring.getDraft(
    workspaceId,
    workflowIdInput,
    actorId,
  );
  if (currentDraft === null) throw new Error('Workflow draft is missing');
  const draft = await authoring.saveDraft({
    actorId,
    workspaceId,
    workflowId: workflowIdInput,
    representationTag: workflowDraftRepresentationTag({
      workflowId: workflowIdInput,
      revision: currentDraft.revision,
      graph: currentDraft.graphJson,
      compatibilityFingerprint: currentDraft.compatibility.fingerprint,
    }),
    expectedRevision: currentDraft.revision,
    graphJson: triggerGraph(30),
  });
  const representationTag = workflowDraftRepresentationTag({
    workflowId: workflowIdInput,
    revision: draft.revision,
    graph: draft.graphJson,
    compatibilityFingerprint: workflowCompatibilityReport(
      draft.graphJson,
      triggerCatalog,
    ).fingerprint,
  });
  const published = await authoring.publishWorkflow({
    actorId,
    workspaceId,
    workflowId: workflowIdInput,
    representationTag,
    idempotencyKey: randomUUID(),
    requestHash: hash(randomUUID()),
  });
  const event = await ownerQuery<{
    id: string;
    payload_checksum: string;
  }>(
    `select id,payload_checksum from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='reconcile-workflow-triggers'
           and payload->>'publishedVersionId'=$3
         order by created_at desc limit 1`,
    [workspaceId, workflowIdInput, published.version.id],
  );
  const row = event.rows[0];
  if (row === undefined) throw new Error('Latest reconciliation event missing');
  return Object.freeze({
    eventChecksum: row.payload_checksum,
    eventId: row.id,
    published,
  });
}

export async function provisionWebhook(workflowIdInput: string) {
  const ids = await workflowTriggerIds(workflowIdInput);
  const endpointKeyHash = hash(`endpoint-${randomUUID()}`);
  const endpointId = randomUUID();
  const { trigger: health } = await webhook.provision({
    workspaceId,
    workflowId: workflowIdInput,
    actorId,
    triggerId: ids.webhookId,
    endpointId,
    endpointKeyHash,
    secret: secret(),
    idempotencyKey: randomUUID(),
    requestHash: hash(randomUUID()),
  });
  return Object.freeze({ endpointId, endpointKeyHash, health, ...ids });
}

export async function createWebhookScenario(
  responseConfig: Record<string, unknown> = {},
) {
  const published = await publishTriggerWorkflow(false, responseConfig);
  await ownerQuery(
    `insert into app.workflow_failure_notification_policies
         (workspace_id,workflow_id,destination_id,updated_by)
       values($1,$2,$3,$4)`,
    [
      workspaceId,
      published.created.workflowId,
      notificationDestinationId,
      actorId,
    ],
  );
  await deliverReconciliation(
    published.created.workflowId,
    published.published.version.id,
    {
      eventId: published.eventId,
      payloadChecksum: published.eventChecksum,
    },
  );
  const resources = await provisionWebhook(published.created.workflowId);
  const verification = await webhook.resolveVerification(
    resources.endpointKeyHash,
  );
  if (verification === null)
    throw new Error('Expected scenario endpoint resolution');
  return Object.freeze({ published, resources, verification });
}
