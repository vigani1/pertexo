import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';

import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import type { QueryResultRow } from 'pg';
import { expect } from 'vitest';

import { ownerRole, quoteIdentifier } from './environment.js';
import { sha256 } from './encryption.js';
import { requireString } from './assertions.js';
import {
  owner,
  identity,
  authoring,
  reconciliation,
  service,
} from './lifecycle.js';

export let workspaceId = '';

export async function seedWebhook(
  label: string,
  responseConfig: Record<string, unknown> = {},
) {
  const actorId = randomUUID();
  workspaceId = randomUUID();
  await identity.createUser({
    id: actorId,
    email: `webhook-http-${actorId}@example.test`,
    displayName: `Webhook HTTP integration ${label}`,
  });
  await identity.createWorkspaceWithOwner({
    id: workspaceId,
    name: `Webhook HTTP integration ${label}`,
    slug: `webhook-http-${actorId}`,
    ownerUserId: actorId,
    idempotencyKey: `webhook-http-${actorId}`,
  });

  const created = await authoring.createWorkflow({
    actorId,
    workspaceId,
    name: 'Direct webhook gate',
    emptyGraph: { settings: {}, nodes: [], edges: [] },
    idempotencyKey: `direct-webhook-create-${label}`,
  });
  const graph = {
    settings: {},
    nodes: [
      {
        id: 'webhook',
        definition: { key: 'core.webhook', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: responseConfig,
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
  };
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
    graphJson: parseWorkflowGraphDraft(graph),
  });
  const published = await authoring.publishWorkflow({
    actorId,
    workspaceId,
    workflowId: created.workflowId,
    representationTag: workflowDraftRepresentationTag({
      workflowId: created.workflowId,
      revision: draft.revision,
      graph: draft.graphJson,
      compatibilityFingerprint: draft.compatibility.fingerprint,
    }),
    idempotencyKey: `direct-webhook-publish-${label}`,
    requestHash: sha256(`direct-webhook-publish-${label}`),
  });
  const publication = await ownerQuery<{
    id: string;
    payload_checksum: string;
  }>(
    `select id,payload_checksum from app.outbox_events
        where workspace_id=$1 and aggregate_id=$2
          and job_name='reconcile-workflow-triggers'`,
    [workspaceId, created.workflowId],
  );
  const publicationRow = publication.rows[0];
  if (publicationRow === undefined)
    throw new Error('Webhook publication outbox is unavailable');
  const health = await reconciliation.reconcile({
    workspaceId,
    workflowId: created.workflowId,
    publishedVersionId: published.version.id,
    outboxEventId: publicationRow.id,
    delivery: {
      outboxEventId: publicationRow.id,
      payloadChecksum: publicationRow.payload_checksum,
    },
  });
  expect(health).toMatchObject([
    { kind: 'webhook', nodeId: 'webhook', status: 'configuration_required' },
  ]);
  const trigger = health[0];
  if (trigger === undefined) throw new Error('Webhook trigger is unavailable');
  const provisioned = await service.provision({
    workspaceId,
    workflowId: created.workflowId,
    actorId,
    triggerId: trigger.id,
    idempotencyKey: `direct-webhook-provision-${label}`,
  });
  expect(provisioned.trigger).toMatchObject({
    status: 'active',
    endpointReady: true,
  });
  expect(provisioned.endpointKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(provisioned.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const endpointKey = requireString(provisioned.endpointKey);
  const originalSecret = requireString(provisioned.signingSecret);
  return {
    provisionLabel: label,
    workspaceId,
    actorId,
    endpointKey,
    originalSecret,
    provisioned,
    trigger,
    workflowId: created.workflowId,
  };
}

export async function ownerQuery<Row extends QueryResultRow = QueryResultRow>(
  statement: string,
  parameters: unknown[] = [],
) {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${quoteIdentifier(ownerRole)}`);
    if (workspaceId !== '')
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
    const result = await client.query<Row>(statement, parameters);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
