import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseRuntime,
  createIdentityWorkspaceDatabase,
  createWorkflowFavoriteDatabase,
  WorkflowFavoriteRevisionConflictError,
  WorkflowOrganizationUnavailableError,
  type WorkflowFavoriteDatabase,
  type WorkflowFavoriteAbsenceTokenAuthority,
} from '@pertexo/database/api';
import {
  parseDatabaseConfig,
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
} from '@pertexo/database/testing';
import { createWorkflowFavoriteAbsenceAuthority } from '../../src/workflow-authoring/favorite-absence-authority.js';
import { createWorkflowOrganizationOwnedDatabase } from '../support/workflow-organization-owned-database.js';

const fixture = createWorkflowOrganizationOwnedDatabase();
const resources: { close(): Promise<void> }[] = [];
let owner: Pool;
let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;
let favorites: WorkflowFavoriteDatabase;
let authority: WorkflowFavoriteAbsenceTokenAuthority;
const verify = vi.fn();
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
      displayName: 'Owned F07 MAC fixture',
    });
  const workspaceId = (
    await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      name: 'Owned F07 MAC fixture',
      slug: `f07-${actorId}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    })
  ).id;
  const workflowId = randomUUID();
  // Synthetic visible metadata row: these tests qualify real MAC/transaction
  // composition, not executable graph admission or workflow creation transport.
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
      'F07 MAC fixture',
      actorId,
      archived ? 'archived' : 'active',
    ],
  );
  return { workspaceId, actorId: viewer, workflowId, ownerId: actorId };
}
async function writer(enabled: boolean) {
  await ownerQuery(
    randomUUID(),
    randomUUID(),
    'update app.workflow_organization_rollout set writes_enabled=$1',
    [enabled],
  );
}

describe.skipIf(process.env.F07_ORGANIZATION_OWNED_FIXTURE !== 'true')(
  'actual application MAC and favorite PostgreSQL adapter',
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
      authority = createWorkflowFavoriteAbsenceAuthority(randomBytes(32));
      verify.mockImplementation(
        (
          ...args: Parameters<WorkflowFavoriteAbsenceTokenAuthority['verify']>
        ) => authority.verify(...args),
      );
      favorites = createWorkflowFavoriteDatabase(config, {
        absenceTokens: {
          issue: (s, snapshot) => authority.issue(s, snapshot),
          verify,
        },
      });
      resources.push(identity, favorites);
      await writer(true);
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
        throw new AggregateError(failures, 'F07 resource cleanup failed');
      await fixture.drop();
    }, 30_000);

    it('accepts a viewer favorite on an archived workflow without returning private generation', async () => {
      const s = await scope(true);
      const input = {
        workspaceId: s.workspaceId,
        actorId: s.actorId,
        workflowId: s.workflowId,
      };
      const absent = await favorites.readFavorite(input);
      expect(Object.keys(absent).sort()).toEqual([
        'favoriteRevision',
        'isFavorite',
      ]);
      expect(absent.isFavorite).toBe(false);
      expect(absent.favoriteRevision).toMatch(/^absent\.v1\./u);
      const result = await favorites.setFavorite({
        ...input,
        favorite: true,
        expectedFavoriteRevision: absent.favoriteRevision,
        idempotencyKey: randomUUID(),
      });
      expect(result.isFavorite).toBe(true);
      expect(result.replayed).toBe(false);
      expect(result.favoriteRevision).toMatch(/^[a-f0-9-]{36}$/u);
      expect(Object.keys(result).sort()).toEqual([
        'favoriteRevision',
        'isFavorite',
        'replayed',
      ]);
      expect(await favorites.readFavorite(input)).toEqual({
        isFavorite: true,
        favoriteRevision: result.favoriteRevision,
      });
    });

    it('exact replay precedes changed MAC key and disabled writer; changed body conflicts before MAC', async () => {
      const s = await scope();
      const input = {
        workspaceId: s.workspaceId,
        actorId: s.actorId,
        workflowId: s.workflowId,
      };
      const absent = await favorites.readFavorite(input);
      const command = {
        ...input,
        favorite: false,
        expectedFavoriteRevision: absent.favoriteRevision,
        idempotencyKey: randomUUID(),
      };
      const accepted = await favorites.setFavorite(command);
      authority = createWorkflowFavoriteAbsenceAuthority(randomBytes(32));
      verify.mockClear();
      await writer(false);
      try {
        expect(await favorites.setFavorite(command)).toEqual({
          ...accepted,
          replayed: true,
        });
        await expect(
          favorites.setFavorite({ ...command, favorite: true }),
        ).rejects.toBeInstanceOf(WorkflowIdempotencyConflictError);
        expect(verify).not.toHaveBeenCalled();
        await expect(
          favorites.setFavorite({
            ...command,
            expectedFavoriteRevision: accepted.favoriteRevision,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(WorkflowOrganizationUnavailableError);
      } finally {
        await writer(true);
      }
    });

    it('bad actual MAC rolls back the unfinished receipt, then the same key accepts corrected bytes', async () => {
      const s = await scope();
      const input = {
        workspaceId: s.workspaceId,
        actorId: s.actorId,
        workflowId: s.workflowId,
      };
      const absent = await favorites.readFavorite(input);
      const key = randomUUID();
      const parts = absent.favoriteRevision.split('.');
      parts[4] = Buffer.alloc(32, 1).toString('base64url');
      await expect(
        favorites.setFavorite({
          ...input,
          favorite: true,
          expectedFavoriteRevision: parts.join('.'),
          idempotencyKey: key,
        }),
      ).rejects.toBeInstanceOf(WorkflowFavoriteRevisionConflictError);
      const hash = createHash('sha256').update(key).digest('hex');
      const rows = await ownerQuery(
        s.workspaceId,
        s.ownerId,
        'select 1 from app.workflow_favorite_receipts where workspace_id=$1 and actor_id=$2 and workflow_id=$3 and key_hash=$4',
        [s.workspaceId, s.actorId, s.workflowId, hash],
      );
      expect(rows.rowCount).toBe(0);
      expect(
        await favorites.setFavorite({
          ...input,
          favorite: true,
          expectedFavoriteRevision: absent.favoriteRevision,
          idempotencyKey: key,
        }),
      ).toMatchObject({ isFavorite: true, replayed: false });
    });

    it('one concurrent new command wins the same absence precondition', async () => {
      const s = await scope();
      const input = {
        workspaceId: s.workspaceId,
        actorId: s.actorId,
        workflowId: s.workflowId,
      };
      const absent = await favorites.readFavorite(input);
      const outcomes = await Promise.allSettled(
        [true, false].map((favorite) =>
          favorites.setFavorite({
            ...input,
            favorite,
            expectedFavoriteRevision: absent.favoriteRevision,
            idempotencyKey: randomUUID(),
          }),
        ),
      );
      expect(
        outcomes.filter((outcome) => outcome.status === 'fulfilled'),
      ).toHaveLength(1);
      const denied = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(
        denied?.status === 'rejected' ? denied.reason : undefined,
      ).toBeInstanceOf(WorkflowFavoriteRevisionConflictError);
    });

    it('fences an old committed receipt and never-delivered actual token after departure/rejoin', async () => {
      const s = await scope();
      const input = {
        workspaceId: s.workspaceId,
        actorId: s.actorId,
        workflowId: s.workflowId,
      };
      const old = await favorites.readFavorite(input);
      const command = {
        ...input,
        favorite: true,
        expectedFavoriteRevision: old.favoriteRevision,
        idempotencyKey: randomUUID(),
      };
      await favorites.setFavorite(command);
      await identity.removeWorkspaceMember({
        workspaceId: s.workspaceId,
        actorUserId: s.ownerId,
        targetUserId: s.actorId,
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      // Privileged fixture mirrors invitation reactivation; no live invitation claim.
      await ownerQuery(
        s.workspaceId,
        s.ownerId,
        "update app.workspace_memberships set status='active',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
        [s.workspaceId, s.actorId],
      );
      const fresh = await favorites.readFavorite(input);
      expect(fresh.isFavorite).toBe(false);
      expect(fresh.favoriteRevision).not.toBe(old.favoriteRevision);
      await expect(favorites.setFavorite(command)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
      await expect(
        favorites.setFavorite({ ...command, idempotencyKey: randomUUID() }),
      ).rejects.toBeInstanceOf(WorkflowFavoriteRevisionConflictError);
      expect(
        await favorites.setFavorite({
          ...command,
          expectedFavoriteRevision: fresh.favoriteRevision,
          idempotencyKey: randomUUID(),
        }),
      ).toMatchObject({ isFavorite: true, replayed: false });
    });

    it.each([-86_400, 60])(
      'SQL rejects a valid MAC with out-of-window database-clock issue offset %s',
      async (offset) => {
        const s = await scope();
        const input = {
          workspaceId: s.workspaceId,
          actorId: s.actorId,
          workflowId: s.workflowId,
        };
        await favorites.readFavorite(input);
        const snapshot = await ownerQuery(
          s.workspaceId,
          s.ownerId,
          'select generation, floor(extract(epoch from clock_timestamp()))::bigint seconds from app.workflow_favorite_membership_generations where workspace_id=$1 and actor_id=$2',
          [s.workspaceId, s.actorId],
        );
        const row = snapshot.rows[0] as
          { generation: string; seconds: string } | undefined;
        if (row === undefined)
          throw new Error('Missing private fixture snapshot');
        const token = authority.issue(input, {
          generation: row.generation,
          issuedAtSeconds: Number(row.seconds) + offset,
        });
        expect(authority.verify(token, input, row.generation)).not.toBeNull();
        await expect(
          favorites.setFavorite({
            ...input,
            favorite: true,
            expectedFavoriteRevision: token,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(WorkflowFavoriteRevisionConflictError);
        expect((await favorites.readFavorite(input)).isFavorite).toBe(false);
      },
    );

    it('does not close an injected runtime when the repository closes', async () => {
      const config = parseDatabaseConfig({
        connectionString: fixture.apiUrl,
        max: 1,
      });
      const runtime = createDatabaseRuntime(config, {});
      try {
        const first = createWorkflowFavoriteDatabase(config, {
          runtime,
          absenceTokens: authority,
        });
        await first.close();
        const second = createWorkflowFavoriteDatabase(config, {
          runtime,
          absenceTokens: authority,
        });
        try {
          const s = await scope();
          expect(
            await second.readFavorite({
              workspaceId: s.workspaceId,
              actorId: s.actorId,
              workflowId: s.workflowId,
            }),
          ).toMatchObject({ isFavorite: false });
        } finally {
          await second.close();
        }
      } finally {
        await runtime.close();
      }
    });
  },
);
