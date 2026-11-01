import {
  workflowFolderCreateRequestSchema,
  workflowFolderRenameRequestSchema,
} from '@pertexo/contracts';
import type { WorkflowOrganizationBatchRequest } from '../../../../src/authoring/index.js';
import {
  commandKey,
  createOrganizationOwnedFixture,
  type OrganizationOwnedFixture,
} from '../owned.fixture.js';

type Scope = Awaited<ReturnType<OrganizationOwnedFixture['scope']>>;

export let fixture: OrganizationOwnedFixture;

let stores: ReturnType<OrganizationOwnedFixture['folderStores']>;

let closeFixture: (() => Promise<void>) | undefined;

export const command = (scope: Scope, key: string, actor: string) => ({
  workspaceId: scope.workspace,
  actorId: actor,
  idempotencyKey: key,
});

export const create = async (
  scope: Scope,
  name: string,
  parentId: string | null = null,
  actor = scope.actor,
) =>
  (
    await stores.folders.createFolder({
      ...command(scope, commandKey(), actor),
      ...workflowFolderCreateRequestSchema.parse({ name, parentId }),
    })
  ).folder;

export const rename = async (
  scope: Scope,
  folderId: string,
  {
    name,
    expectedFolderRevision,
    key = commandKey(),
  }: Readonly<{
    name: string;
    expectedFolderRevision: number;
    key?: string | undefined;
  }>,
) =>
  stores.folders.renameFolder({
    ...command(scope, key, scope.actor),
    folderId,
    ...workflowFolderRenameRequestSchema.parse({
      name,
      expectedFolderRevision,
    }),
  });

export const moveFolder = (
  scope: Scope,
  folderId: string,
  parentId: string | null,
  expectedFolderRevision: number,
) =>
  stores.folders.moveFolder({
    ...command(scope, commandKey(), scope.actor),
    folderId,
    parentId,
    expectedFolderRevision,
  });

export const remove = (
  scope: Scope,
  folderId: string,
  expectedFolderRevision = 1,
) =>
  stores.folders.deleteFolder({
    ...command(scope, commandKey(), scope.actor),
    folderId,
    expectedFolderRevision,
  });

export const place = (
  scope: Scope,
  workflowId: string,
  {
    folderId,
    expectedOrganizationRevision = 1,
    key = commandKey(),
    actor = scope.actor,
  }: Readonly<{
    folderId: string | null;
    expectedOrganizationRevision?: number | undefined;
    key?: string | undefined;
    actor?: string | undefined;
  }>,
) =>
  stores.folders.placeWorkflow({
    ...command(scope, key, actor),
    workflowId,
    folderId,
    expectedOrganizationRevision,
  });

export const admit = (
  scope: Scope,
  key: string,
  request: WorkflowOrganizationBatchRequest,
  actor = scope.actor,
) => stores.batches.admitBatch({ ...command(scope, key, actor), request });

export const item = (
  scope: Scope,
  key: string,
  {
    request,
    workflowId,
    actor = scope.actor,
  }: Readonly<{
    request: WorkflowOrganizationBatchRequest;
    workflowId: string;
    actor?: string | undefined;
  }>,
) =>
  stores.batches.executeBatchItem({
    ...command(scope, key, actor),
    request,
    workflowId,
  });

export const move = (
  workflowId: string,
  revision = 1,
): WorkflowOrganizationBatchRequest => ({
  operation: 'move',
  folderId: null,
  items: [{ workflowId, expectedOrganizationRevision: revision }],
});

export async function owner(
  scope: Scope,
  query: string,
  values: unknown[] = [],
) {
  return fixture.transaction(
    fixture.owner,
    scope.workspace,
    scope.actor,
    (client) => client.query(query, values),
  );
}

export async function folderIds(scope: Scope, actor: string) {
  return fixture.transaction(
    fixture.api,
    scope.workspace,
    actor,
    async (client) =>
      (
        await client.query<{ id: string }>(
          'select id from app.workflow_folders order by id',
        )
      ).rows.map((row) => row.id),
  );
}

export async function beforeAllFixture1() {
  fixture = await createOrganizationOwnedFixture();
  closeFixture = fixture.close;
  stores = fixture.folderStores();
}

export async function afterAllFixture2() {
  await closeFixture?.();
}
