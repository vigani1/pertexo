import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdentityWorkspaceDatabase } from '@pertexo/database/tenant-access';
import {
  createWorkflowFavoriteDatabase,
  createWorkflowOrganizationReadDatabase,
  type WorkflowFavoriteDatabase,
  type WorkflowOrganizationReadDatabase,
} from '@pertexo/database/authoring';
import {
  parseDatabaseConfig,
  WorkflowNotFoundError,
} from '@pertexo/database/testing';
import { createWorkflowOrganizationOwnedDatabase } from '../support/workflow-organization-owned-database.js';

const fixture = createWorkflowOrganizationOwnedDatabase();
const resources: { close(): Promise<void> }[] = [];
let owner: Pool;
let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;
let favorites: WorkflowFavoriteDatabase;
let organization: WorkflowOrganizationReadDatabase;
async function ownerQuery(
  workspaceId: string,
  actorId: string,
  sql: string,
  args: unknown[] = [],
) {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("set local statement_timeout='5s'");
    await client.query(
      "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [workspaceId, actorId],
    );
    const result = await client.query(sql, args);
    await client.query('commit');
    return result;
  } finally {
    try {
      await client.query('rollback');
    } finally {
      client.release();
    }
  }
}
async function scope(archived = false) {
  const actorId = randomUUID(),
    viewer = randomUUID();
  for (const id of [actorId, viewer])
    await identity.createUser({
      id,
      email: `${id}@example.test`,
      displayName: 'Owned favorites fixture',
    });
  const workspaceId = (
    await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      name: 'Owned favorites fixture',
      slug: `f07-${actorId}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    })
  ).id;
  const workflowId = randomUUID();
  // A plain workflow row is enough: favorites do not read the graph.
  await ownerQuery(
    workspaceId,
    actorId,
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')",
    [workspaceId, viewer],
  );
  await ownerQuery(
    workspaceId,
    actorId,
    'insert into app.workflows(id,workspace_id,name,created_by,lifecycle_status) values($1,$2,$3,$4,$5)',
    [
      workflowId,
      workspaceId,
      'Favorites fixture',
      actorId,
      archived ? 'archived' : 'active',
    ],
  );
  return { workspaceId, actorId: viewer, workflowId, ownerId: actorId };
}
async function favoriteRows(s: Awaited<ReturnType<typeof scope>>) {
  const result = await ownerQuery(
    s.workspaceId,
    s.ownerId,
    'select actor_id from app.workflow_favorites where workspace_id=$1 and workflow_id=$2',
    [s.workspaceId, s.workflowId],
  );
  return result.rows as readonly { actor_id: string }[];
}
async function isFavorite(
  s: Awaited<ReturnType<typeof scope>>,
  actorId: string,
) {
  return (
    await organization.getWorkflow({
      workspaceId: s.workspaceId,
      actorId,
      workflowId: s.workflowId,
    })
  )?.organization.isFavorite;
}

describe.skipIf(process.env.F07_ORGANIZATION_OWNED_FIXTURE !== 'true')(
  'workflow favorites in PostgreSQL',
  () => {
    beforeAll(async () => {
      await fixture.create();
      owner = new Pool({
        connectionString: fixture.inspectorUrl,
        max: 2,
        connectionTimeoutMillis: 3000,
      });
      resources.push({ close: () => owner.end() });
      const config = parseDatabaseConfig({
        connectionString: fixture.apiUrl,
        max: 4,
      });
      identity = createIdentityWorkspaceDatabase(config);
      favorites = createWorkflowFavoriteDatabase(config);
      organization = createWorkflowOrganizationReadDatabase(config);
      resources.push(identity, favorites, organization);
    }, 120_000);
    afterAll(async () => {
      const failures: unknown[] = [];
      for (const resource of resources.reverse()) {
        try {
          await resource.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Favorites resource cleanup failed');
      await fixture.drop();
    }, 30_000);

    it('lets a viewer favorite an archived workflow, visible only to that viewer', async () => {
      const s = await scope(true);
      const input = {
        workspaceId: s.workspaceId,
        actorId: s.actorId,
        workflowId: s.workflowId,
      };
      expect(await favorites.setFavorite({ ...input, favorite: true })).toEqual(
        { isFavorite: true },
      );
      expect(await favorites.setFavorite({ ...input, favorite: true })).toEqual(
        { isFavorite: true },
      );
      expect(await favoriteRows(s)).toEqual([{ actor_id: s.actorId }]);
      expect(await isFavorite(s, s.actorId)).toBe(true);
      expect(await isFavorite(s, s.ownerId)).toBe(false);
    });

    it('unfavorites, and asking again for the same state changes nothing', async () => {
      const s = await scope();
      const input = {
        workspaceId: s.workspaceId,
        actorId: s.actorId,
        workflowId: s.workflowId,
      };
      await favorites.setFavorite({ ...input, favorite: true });
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(
          await favorites.setFavorite({ ...input, favorite: false }),
        ).toEqual({ isFavorite: false });
      expect(await favoriteRows(s)).toEqual([]);
      expect(await isFavorite(s, s.actorId)).toBe(false);
    });

    it('does not favorite a workflow outside the workspace', async () => {
      const s = await scope();
      await expect(
        favorites.setFavorite({
          workspaceId: s.workspaceId,
          actorId: s.actorId,
          workflowId: randomUUID(),
          favorite: true,
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    });

    it("removes a member's favorites when the member is removed", async () => {
      const s = await scope();
      await favorites.setFavorite({
        workspaceId: s.workspaceId,
        actorId: s.actorId,
        workflowId: s.workflowId,
        favorite: true,
      });
      await identity.removeWorkspaceMember({
        workspaceId: s.workspaceId,
        actorUserId: s.ownerId,
        targetUserId: s.actorId,
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      expect(await favoriteRows(s)).toEqual([]);
    });
  },
);
