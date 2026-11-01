import type { WorkflowGraph } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';

import { createWorkflowAuthoringFixtureDatabase } from '../../../support/workflow-authoring-admission.fixture.js';
import {
  actorId,
  workspaceId,
  otherWorkspaceId,
  apiUrl,
  parseDatabaseConfig,
  emptyGraph,
  currentRepresentationTag,
  queryAsOwner,
  saveCurrentDraft,
} from '../../../support/workflow-authoring.js';

export const database = createWorkflowAuthoringFixtureDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  {
    definitionCatalog: {
      definitions: [{ key: 'test.placeholder', version: 1 }],
    },
    portableCatalog: {
      definitions: [
        {
          key: 'test.placeholder',
          version: 1,
          configVersion: 1,
          slots: [],
          validateConfig: () => true,
        },
      ],
    },
  },
);

export const scope = () => ({ workspaceId, actorId });

export function promotions() {
  if (database.promotions === undefined)
    throw new Error('Promotion store missing');
  return database.promotions;
}

export async function configure() {
  const settings = await promotions().settings(scope());
  return promotions().setTarget({
    ...scope(),
    expectedRevision: settings.revision,
    expectedTargetWorkspaceId: settings.target?.workspaceId ?? null,
    targetWorkspaceId: otherWorkspaceId,
    idempotencyKey: randomUUID(),
  });
}

export async function published(graph: WorkflowGraph = emptyGraph) {
  const created = await database.createWorkflow({
    ...scope(),
    name: `Promoted ${randomUUID()}`,
    emptyGraph,
    idempotencyKey: randomUUID(),
  });
  if (graph.nodes.length > 0 || (graph.notes?.length ?? 0) > 0)
    await saveCurrentDraft(database, {
      ...scope(),
      workflowId: created.workflowId,
      expectedRevision: 1,
      graphJson: graph,
    });
  const version = (
    await database.publishWorkflow({
      ...scope(),
      workflowId: created.workflowId,
      representationTag: await currentRepresentationTag(database, workspaceId, {
        scopedWorkflowId: created.workflowId,
        scopedActorId: actorId,
      }),
      requestHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    })
  ).version;
  return { workflowId: created.workflowId, versionId: version.id };
}

export async function beforeAllFixture1() {
  await queryAsOwner(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active') on conflict(workspace_id,user_id) do update set role='builder',status='active'",
    [otherWorkspaceId, actorId],
    otherWorkspaceId,
  );
}

export async function afterAllFixture2() {
  return database.close();
}
