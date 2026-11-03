import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';

import { createWorkflowFolderStore } from '../../../../src/authoring/organization/folders/workflow-folder.store.js';
import { createWorkflowInputCaseStore } from '../../../../src/authoring/input-cases/workflow-input-case.store.js';
import {
  actorId,
  apiUrl,
  authoring,
  currentRepresentationTag,
  emptyGraph,
  identity,
  queryAsOwner,
  workspaceId,
} from '../../../support/workflow-authoring.js';

export const outsider = randomUUID(),
  viewer = randomUUID(),
  builder = randomUUID();

export let folders: ReturnType<typeof createWorkflowFolderStore>;
export let inputCases: ReturnType<typeof createWorkflowInputCaseStore>;

export type Target = Readonly<{
  id: string;
  versionId: string;
  tag: string;
}>;

/** Open to everyone in the workspace. */
export let open: Target;
/** In a folder the builder has no grant on. */
export let hidden: Target;
/** In a folder where the builder holds a viewer's grant. */
export let readOnly: Target;
export let hiddenFolderId: string;

export const graphWith = (label: string) => ({
  ...emptyGraph,
  settings: { maxRunDurationMs: label.length * 1_000 },
});

export async function publishedWorkflow(name: string): Promise<Target> {
  const { workflowId: id } = await authoring.createWorkflow({
    workspaceId,
    actorId,
    name,
    emptyGraph,
    idempotencyKey: randomUUID(),
  });
  const tag = () =>
    currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: id,
      scopedActorId: actorId,
    });
  const { version } = await authoring.publishWorkflow({
    workspaceId,
    actorId,
    workflowId: id,
    representationTag: await tag(),
    requestHash: 'a'.repeat(64),
    idempotencyKey: randomUUID(),
  });
  return { id, versionId: version.id, tag: await tag() };
}

async function restrictedFolder(
  name: string,
  grants: readonly Readonly<{
    kind: 'member';
    userId: string;
    access: 'viewer';
  }>[],
) {
  const { folder } = await folders.createFolder({
    workspaceId,
    actorId,
    name,
    parentId: null,
    idempotencyKey: randomUUID(),
  });
  await folders.replaceSharing({
    workspaceId,
    actorId,
    folderId: folder.id,
    idempotencyKey: randomUUID(),
    request: {
      mode: 'restricted',
      expectedFolderRevision: folder.revision,
      grants: [...grants],
    },
  });
  return folder.id;
}

export const moveIntoFolder = async (workflowId: string, folderId: string) =>
  folders.placeWorkflow({
    workspaceId,
    actorId,
    workflowId,
    folderId,
    expectedOrganizationRevision: 1,
    idempotencyKey: randomUUID(),
  });

export async function openWorld() {
  const config = parseDatabaseConfig({ connectionString: apiUrl, max: 3 });
  folders = createWorkflowFolderStore(config);
  inputCases = createWorkflowInputCaseStore(config);
  for (const [id, role] of [
    [outsider, null],
    [viewer, 'viewer'],
    [builder, 'builder'],
  ] as const) {
    await identity.createUser({
      id,
      email: `${id}@example.test`,
      displayName: role ?? 'outsider',
    });
    if (role !== null)
      await queryAsOwner(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active') returning 1",
        [workspaceId, id, role],
        workspaceId,
      );
  }
  open = await publishedWorkflow('Open');
  hidden = await publishedWorkflow('Hidden');
  readOnly = await publishedWorkflow('Read only');
  hiddenFolderId = await restrictedFolder('Hidden', []);
  await moveIntoFolder(hidden.id, hiddenFolderId);
  await moveIntoFolder(
    readOnly.id,
    await restrictedFolder('Read only', [
      { kind: 'member', userId: builder, access: 'viewer' },
    ]),
  );
}

export async function closeWorld() {
  await folders.close();
  await inputCases.close();
}
