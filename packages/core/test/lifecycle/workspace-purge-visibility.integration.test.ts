import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createIdentityWorkspaceStore } from '../../src/tenant-access/identity-workspace.store.js';
import {
  beforeAllFixture1,
  afterAllFixture2,
  adminUrl,
  databaseName,
  createWorkspace,
  coordinator,
} from './workspace-purge/workspace-purge.fixture.js';
import { makeWorkspaceDueForPurge } from '../support/workspace-purge.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

it.each(['paused', 'incomplete'] as const)(
  'keeps current-member discovery until object erasure finishes: %s',
  async (stage) => {
    const workspaceId = await createWorkspace();
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    const appUrl = new URL(
      process.env.DATABASE_URL ??
        'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
    );
    appUrl.pathname = '/' + databaseName;
    const discovery = createIdentityWorkspaceStore(
      parseDatabaseConfig({ connectionString: appUrl.toString(), max: 1 }),
    );
    const started = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    let complete = false;
    const purge = coordinator({
      async purgeWorkspacePage() {
        started.resolve(undefined);
        if (stage === 'paused') await resume.promise;
        return { completed: complete, deletedCount: 0 };
      },
    });
    let pending: Promise<unknown> | undefined;
    try {
      const workspace = (
        await admin.query<{ created_by: string }>(
          'select created_by from app.workspaces where id=$1',
          [workspaceId],
        )
      ).rows[0];
      if (workspace === undefined) throw new Error('Missing seeded workspace');
      const user = workspace.created_by;
      await admin.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
        [workspaceId, user],
      );
      const outsider = randomUUID();
      await admin.query(
        "insert into app.users(id,email,display_name) values($1,$1::uuid::text||'@purge.test','Non-member')",
        [outsider],
      );
      await admin.query(
        "insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,1,'{}')",
        [workspaceId],
      );
      await makeWorkspaceDueForPurge(adminUrl, workspaceId);
      const visible = async () => {
        expect(
          (await discovery.listAccessibleWorkspaces(user)).items,
        ).toContainEqual(
          expect.objectContaining({ id: workspaceId, status: 'purging' }),
        );
        expect(
          (await discovery.listAccessibleWorkspaces(outsider)).items,
        ).toEqual([]);
      };
      expect(await purge.processNext()).toMatchObject({
        status: 'started',
        workspaceId,
      });
      await visible();
      let rowPages = 0;
      for (let i = 0; i < 100; i++) {
        const next = purge.processNext();
        const result = await Promise.race([
          next,
          started.promise.then(() => 'objects' as const),
        ]);
        if (result === 'objects') {
          pending = next;
          break;
        }
        rowPages += 1;
        if (stage === 'incomplete') await visible();
      }
      expect(rowPages).toBeGreaterThan(0);
      expect(pending).toBeDefined();
      await visible();
      if (stage === 'paused') {
        complete = true;
        resume.resolve(undefined);
      } else {
        await expect(pending).resolves.toMatchObject({
          status: 'progressed',
          step: 'objects',
        });
        await visible();
        complete = true;
        pending = purge.processNext();
      }
      await expect(pending).resolves.toMatchObject({
        status: 'completed',
        workspaceId,
      });
      expect(
        (
          await admin.query(
            'select status,created_by,deletion_requested_by from app.workspaces where id=$1',
            [workspaceId],
          )
        ).rows,
      ).toEqual([
        { status: 'deleted', created_by: null, deletion_requested_by: null },
      ]);
      expect(
        (
          await admin.query(
            'select user_id from app.workspace_memberships where workspace_id=$1',
            [workspaceId],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (await discovery.listAccessibleWorkspaces(user)).items.map(
          (item) => item.id,
        ),
      ).not.toContain(workspaceId);
    } finally {
      complete = true;
      resume.resolve(undefined);
      await pending?.catch(() => undefined);
      for (let i = 0; i < 100; i++) {
        const stored = await admin.query<{ status: string }>(
          'select status from app.workspaces where id=$1',
          [workspaceId],
        );
        if (stored.rows[0]?.status === 'deleted') break;
        await purge.processNext();
      }
      await Promise.all([purge.close(), discovery.close(), admin.end()]);
    }
  },
);
