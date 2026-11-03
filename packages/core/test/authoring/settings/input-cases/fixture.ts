import { createWorkflowInputCaseStore } from '../../../../src/authoring/input-cases/workflow-input-case.store.js';

import {
  actorId,
  workspaceId,
  apiUrl,
  authoring,
  currentRepresentationTag,
  emptyGraph,
  randomUUID,
  parseDatabaseConfig,
} from '../../../support/workflow-authoring.js';

export let database: ReturnType<typeof createWorkflowInputCaseStore>;

export async function fixture(selectedWorkspaceId = workspaceId) {
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId: selectedWorkspaceId,
    emptyGraph,
    name: 'Input cases',
    idempotencyKey: randomUUID(),
  });
  const workflowId = created.workflowId;
  const publication = await authoring.publishWorkflow({
    actorId,
    workspaceId: selectedWorkspaceId,
    workflowId,
    representationTag: await currentRepresentationTag(
      authoring,
      selectedWorkspaceId,
      { scopedWorkflowId: workflowId, scopedActorId: actorId },
    ),
    idempotencyKey: randomUUID(),
    requestHash: '0'.repeat(64),
  });
  return {
    actorId,
    workspaceId: selectedWorkspaceId,
    workflowId,
    workflowVersionId: publication.version.id,
  };
}

export function beforeAllFixture1() {
  database = createWorkflowInputCaseStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
  );
}

export async function afterAllFixture2() {
  await database.close();
}
