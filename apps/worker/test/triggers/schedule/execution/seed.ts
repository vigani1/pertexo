import { createHash } from 'node:crypto';
import {
  createIdentityWorkspaceDatabase,
  createWorkflowAuthoringDatabase,
} from '@pertexo/core/testing';

import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';

import {
  actorId,
  apiConfig,
  authoringOptions,
  workspaceId,
  registerResource,
} from '../fixture.js';

export async function seedScheduleQualification() {
  const identity = registerResource(createIdentityWorkspaceDatabase(apiConfig));
  const authoring = registerResource(
    createWorkflowAuthoringDatabase(
      apiConfig,
      authoringOptions.databaseOptions,
    ),
  );
  await identity.createUser({
    id: actorId,
    email: `worker-schedule-${actorId}@example.test`,
    displayName: 'Worker Schedule Owner',
  });
  await identity.createWorkspaceWithOwner({
    id: workspaceId,
    name: 'Worker Schedule Proof',
    slug: `worker-schedule-${actorId}`,
    ownerUserId: actorId,
    idempotencyKey: `worker-schedule-${actorId}`,
  });
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId,
    name: 'Direct Schedule worker proof',
    emptyGraph: { settings: {}, nodes: [], edges: [] },
    idempotencyKey: 'create-schedule-worker-proof',
  });
  const graph = {
    settings: {},
    nodes: [
      {
        id: 'schedule',
        definition: { key: 'core.schedule', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {
          kind: 'interval',
          intervalMinutes: 1,
          misfirePolicy: 'catch_up_once',
        },
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
    graphJson: graph,
  });
  const catalog = authoringOptions.definitionCatalog;
  const publication = await authoring.publishWorkflow({
    actorId,
    workspaceId,
    workflowId: created.workflowId,
    representationTag: workflowDraftRepresentationTag({
      workflowId: created.workflowId,
      revision: draft.revision,
      graph: draft.graphJson,
      compatibilityFingerprint: workflowCompatibilityReport(
        draft.graphJson,
        catalog,
      ).fingerprint,
    }),
    idempotencyKey: 'publish-schedule-worker-proof',
    requestHash: createHash('sha256')
      .update('publish-schedule-worker-proof')
      .digest('hex'),
  });

  return { identity, authoring, created, graph, catalog, publication };
}
