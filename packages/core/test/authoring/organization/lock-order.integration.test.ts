import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './owned.fixture.js';

/** Postgres ends one side of a deadlock with 40P01, however the flow words it. */
function deadlocked(result: PromiseSettledResult<unknown>) {
  if (result.status === 'fulfilled') return false;
  for (let error: unknown = result.reason; error instanceof Object; ) {
    if ('code' in error && error.code === '40P01') return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}

describe.skipIf(!organizationFixtureEnabled)(
  'organization commands take their locks in one order',
  () => {
    let fixture: OrganizationOwnedFixture;
    let stores: ReturnType<OrganizationOwnedFixture['folderStores']>;
    let read: ReturnType<OrganizationOwnedFixture['organizationStores']>;
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      stores = fixture.folderStores();
      read = fixture.organizationStores();
    }, 120_000);
    afterAll(() => fixture.close(), 30_000);

    const folder = (workspaceId: string, actorId: string) =>
      stores.folders.createFolder({
        workspaceId,
        actorId,
        name: `Folder ${randomUUID()}`,
        parentId: null,
        idempotencyKey: randomUUID(),
      });

    it('in one workspace, against readers, tags, favorites and draft saves', async () => {
      const { actor, workspace, workflow } = await fixture.scope();
      const workflowId = await workflow();
      const scope = { workspaceId: workspace, actorId: actor };
      const results = await Promise.allSettled(
        Array.from({ length: 8 }).flatMap((_, turn) => [
          folder(workspace, actor),
          fixture.tags.createTag({
            ...scope,
            key: `tag-${String(turn)}`,
            idempotencyKey: randomUUID(),
          }),
          stores.folders.listFolders(scope),
          read.favorites.setFavorite({
            ...scope,
            workflowId,
            favorite: turn % 2 === 0,
          }),
          read.reader.listWorkflows(scope),
          fixture.authoring.getDraft(workspace, workflowId, actor),
        ]),
      );
      expect(results.filter(deadlocked)).toEqual([]);
      expect(results.filter((one) => one.status === 'rejected')).toEqual([]);
    }, 60_000);

    it('one person in two workspaces, in both orders', async () => {
      const first = await fixture.scope();
      const second = await fixture.scope();
      await fixture.transaction(
        fixture.owner,
        second.workspace,
        second.actor,
        (client) =>
          client.query(
            `insert into app.workspace_memberships(workspace_id,user_id,role,status)
             values($1,$2,'admin','active')`,
            [second.workspace, first.actor],
          ),
      );
      const results = await Promise.allSettled(
        Array.from({ length: 12 }).flatMap(() => [
          folder(first.workspace, first.actor),
          folder(second.workspace, first.actor),
        ]),
      );
      expect(results.filter(deadlocked)).toEqual([]);
      expect(results.filter((one) => one.status === 'rejected')).toEqual([]);
    }, 60_000);

    it('against a rename, which locks the same person for update', async () => {
      const first = await fixture.scope();
      const second = await fixture.scope();
      await fixture.transaction(
        fixture.owner,
        second.workspace,
        second.actor,
        (client) =>
          client.query(
            `insert into app.workspace_memberships(workspace_id,user_id,role,status)
             values($1,$2,'admin','active')`,
            [second.workspace, first.actor],
          ),
      );
      // Revisions move underneath the renames, so a refusal is fine; a deadlock isn't.
      const results = await Promise.allSettled(
        Array.from({ length: 12 }).flatMap((_, turn) => [
          folder(first.workspace, first.actor),
          folder(second.workspace, first.actor),
          fixture.identity.renameWorkspace({
            workspaceId: first.workspace,
            actorUserId: first.actor,
            name: `Renamed ${String(turn)}`,
            expectedRevision: 1,
            idempotencyKey: randomUUID(),
          }),
          fixture.identity.renameWorkspace({
            workspaceId: second.workspace,
            actorUserId: first.actor,
            name: `Renamed ${String(turn)}`,
            expectedRevision: 1,
            idempotencyKey: randomUUID(),
          }),
        ]),
      );
      expect(results.filter(deadlocked)).toEqual([]);
    }, 60_000);
  },
);
