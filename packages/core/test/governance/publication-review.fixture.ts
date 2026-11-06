import { randomUUID } from 'node:crypto';

import { createGovernanceStore } from '../../src/governance/index.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';

import {
  apiUrl,
  actorId,
  workspaceId,
  authoring,
  identity,
  emptyGraph,
  currentRepresentationTag,
  queryAsOwner,
} from '../support/workflow-authoring.js';

export const builder = randomUUID(),
  admin = randomUUID();

export let settings: ReturnType<typeof createGovernanceStore>;

export function reviews() {
  return authoring.publicationReviews;
}

/** A new workflow and the request for it, not yet sent. */
export async function requestFor(requester = builder, space = workspaceId) {
  const created = await authoring.createWorkflow({
    workspaceId: space,
    actorId: requester,
    name: 'Reviewed workflow',
    emptyGraph,
    idempotencyKey: randomUUID(),
  });
  return {
    workspaceId: space,
    actorId: requester,
    workflowId: created.workflowId,
    representationTag: await currentRepresentationTag(authoring, space, {
      scopedWorkflowId: created.workflowId,
      scopedActorId: requester,
    }),
    note: 'PRIVATE_REVIEW_NOTE',
    idempotencyKey: randomUUID(),
  };
}

export async function request(requester = builder) {
  const command = await requestFor(requester);
  return { command, review: await reviews().request(command) };
}

export async function beforeAllFixture1() {
  settings = createGovernanceStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  for (const [userId, role] of [
    [builder, 'builder'],
    [admin, 'admin'],
  ] as const) {
    await identity.createUser({
      id: userId,
      email: `${userId}@example.test`,
      displayName: role,
    });
    await queryAsOwner(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
      [workspaceId, userId, role],
      workspaceId,
    );
  }
  const initial = await settings.settings({ workspaceId, actorId });
  await settings.configure({
    workspaceId,
    actorId,
    expectedRevision: initial.revision,
    requirePublishApproval: true,
    idempotencyKey: randomUUID(),
  });
}

export async function afterAllFixture2() {
  return settings.close();
}
