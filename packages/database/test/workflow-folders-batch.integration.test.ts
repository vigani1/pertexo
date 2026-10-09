import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commandKey,
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';
import { enforceRetention } from './support/retention.js';

type Scope = Awaited<ReturnType<OrganizationOwnedFixture['scope']>>;
interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  revision: number;
  depth: number;
}
interface Result {
  folder: Folder;
  replayed: boolean;
  organizationRevision: number;
  folderId: string | null;
}
let fixture: OrganizationOwnedFixture;
let closeFixture: (() => Promise<void>) | undefined;
const itemKey = (key: string, workflow: string) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        p: 'organization.batch.item',
        k: key,
        id: workflow,
      }),
    )
    .digest('hex');
async function sql<T>(
  scope: Scope,
  query: string,
  values: unknown[],
  actor = scope.actor,
) {
  return fixture.transaction(
    fixture.api,
    scope.workspace,
    actor,
    async (client) => {
      const result = await client.query<{ result: T }>(query, values);
      if (result.rows[0] === undefined)
        throw new Error('Missing owned F07 SQL result');
      return result.rows[0].result;
    },
  );
}
const folder = (
  scope: Scope,
  operation: string,
  id: string | null,
  body: object,
  key = commandKey(),
  actor = scope.actor,
) =>
  sql<Result>(
    scope,
    'select app.execute_workflow_folder_command($1,$2,$3,$4::jsonb) result',
    [operation, id, key, JSON.stringify(body)],
    actor,
  );
const create = async (
  scope: Scope,
  name: string,
  parentId: string | null = null,
) => (await folder(scope, 'folder.create', null, { name, parentId })).folder;
const place = (
  scope: Scope,
  workflow: string,
  folderId: string | null,
  expectedOrganizationRevision = 1,
  key = commandKey(),
  actor = scope.actor,
) =>
  sql<Result>(
    scope,
    'select app.execute_workflow_folder_placement($1,$2,$3::jsonb) result',
    [workflow, key, JSON.stringify({ folderId, expectedOrganizationRevision })],
    actor,
  );
const admit = (scope: Scope, key: string, body: object, actor = scope.actor) =>
  sql<{ admitted: true }>(
    scope,
    'select app.admit_workflow_organization_batch($1,$2::jsonb) result',
    [key, JSON.stringify(body)],
    actor,
  );
const item = (
  scope: Scope,
  key: string,
  body: object,
  workflow: string,
  actor = scope.actor,
  derivedKey = itemKey(key, workflow),
) =>
  sql<Result>(
    scope,
    'select app.execute_workflow_organization_batch_item($1,$2::jsonb,$3,$4) result',
    [key, JSON.stringify(body), workflow, derivedKey],
    actor,
  );
const move = (workflowId: string, revision = 1) => ({
  operation: 'move',
  folderId: null,
  items: [{ workflowId, expectedOrganizationRevision: revision }],
});
async function owner(scope: Scope, query: string, values: unknown[] = []) {
  return fixture.transaction(
    fixture.owner,
    scope.workspace,
    scope.actor,
    (client) => client.query(query, values),
  );
}

describe.skipIf(!organizationFixtureEnabled)(
  '0135 owned folder and committed batch admission',
  () => {
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      closeFixture = fixture.close;
      await fixture.owner.query(
        'update app.workflow_organization_rollout set writes_enabled=true',
      );
    }, 60_000);
    afterAll(async () => {
      await closeFixture?.();
    });

    it('preserves case and ASCII-only sibling uniqueness, revisions and scoped parents', async () => {
      const scope = await fixture.scope();
      const first = await create(scope, ' Ops ');
      expect(first).toMatchObject({
        name: 'Ops',
        parentId: null,
        depth: 1,
        revision: 1,
      });
      await expect(create(scope, 'ops')).rejects.toMatchObject({
        code: 'P7011',
      });
      const upper = await create(scope, 'Équipe');
      const lower = await create(scope, 'équipe');
      expect(upper.id).not.toBe(lower.id);
      await expect(create(scope, 'bad\tname')).rejects.toMatchObject({
        code: '22023',
      });
      await expect(create(scope, 'é'.repeat(65))).rejects.toMatchObject({
        code: '22023',
      });
      const other = await fixture.scope();
      await expect(create(other, 'foreign', first.id)).rejects.toMatchObject({
        code: '42501',
      });
      const key = commandKey();
      const renamed = await folder(
        scope,
        'folder.rename',
        first.id,
        { name: 'Ops', expectedFolderRevision: 1 },
        key,
      );
      expect(renamed.folder.revision).toBe(2);
      expect(
        await folder(
          scope,
          'folder.rename',
          first.id,
          { name: 'Ops', expectedFolderRevision: 1 },
          key,
        ),
      ).toMatchObject({
        folder: { revision: 2 },
        replayed: true,
      });
      await expect(
        folder(scope, 'folder.rename', first.id, {
          name: 'New',
          expectedFolderRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'P7013' });
    });
    it('checks subtree height and cycles without rewriting descendant identities or revisions', async () => {
      const scope = await fixture.scope();
      const a = await create(scope, 'a'),
        b = await create(scope, 'b', a.id),
        c = await create(scope, 'c', b.id),
        d = await create(scope, 'd', c.id);
      await expect(create(scope, 'too deep', d.id)).rejects.toMatchObject({
        code: 'P7014',
      });
      await expect(
        folder(scope, 'folder.move', a.id, {
          parentId: d.id,
          expectedFolderRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'P7014' });
      const other = await create(scope, 'other'),
        child = await create(scope, 'child', other.id);
      await expect(
        folder(scope, 'folder.move', b.id, {
          parentId: child.id,
          expectedFolderRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'P7014' });
      expect(
        (
          await folder(scope, 'folder.move', b.id, {
            parentId: other.id,
            expectedFolderRevision: 1,
          })
        ).folder,
      ).toMatchObject({ id: b.id, revision: 2, depth: 2 });
      expect(
        (
          await owner(
            scope,
            'select id,revision::int revision from app.workflow_folders where id=$1',
            [d.id],
          )
        ).rows,
      ).toEqual([{ id: d.id, revision: 1 }]);
    });
    it('bounds workspace folder quota and converges concurrent sibling creation', async () => {
      const scope = await fixture.scope();
      const results = await Promise.allSettled([
        create(scope, 'Shared'),
        create(scope, 'shared'),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(
        rejected?.status === 'rejected' ? rejected.reason : undefined,
      ).toMatchObject({ code: 'P7011' });
      await owner(
        scope,
        `insert into app.workflow_folders(workspace_id,id,name,name_key)
        select $1,uuidv7(),'f-'||n,'f-'||n from generate_series(1,255) n`,
        [scope.workspace],
      );
      await expect(create(scope, 'overflow')).rejects.toMatchObject({
        code: 'P7012',
      });
      expect(
        (
          await owner(
            scope,
            'select count(*)::int count from app.workflow_folders where workspace_id=$1',
            [scope.workspace],
          )
        ).rows,
      ).toEqual([{ count: 256 }]);
    });
    it('uses shared organization CAS, preserves timestamps, and refuses nonempty including archived placement', async () => {
      const scope = await fixture.scope(),
        target = await create(scope, 'target'),
        workflow = await scope.workflow();
      const before = (
        await owner(scope, 'select updated_at from app.workflows where id=$1', [
          workflow,
        ])
      ).rows;
      const key = commandKey();
      expect(await place(scope, workflow, target.id, 1, key)).toMatchObject({
        folderId: target.id,
        organizationRevision: 2,
        replayed: false,
      });
      expect(await place(scope, workflow, target.id, 1, key)).toMatchObject({
        organizationRevision: 2,
        replayed: true,
      });
      await expect(place(scope, workflow, null, 1)).rejects.toMatchObject({
        code: 'P7008',
      });
      await expect(
        folder(scope, 'folder.delete', target.id, {
          expectedFolderRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'P7015' });
      await owner(
        scope,
        "update app.workflows set lifecycle_status='archived' where id=$1",
        [workflow],
      );
      await expect(
        place(scope, workflow, null, 2, commandKey(), scope.builder),
      ).rejects.toMatchObject({ code: 'P7009' });
      await expect(
        folder(scope, 'folder.delete', target.id, {
          expectedFolderRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'P7015' });
      expect(await place(scope, workflow, null, 2)).toMatchObject({
        folderId: null,
        organizationRevision: 3,
      });
      await folder(scope, 'folder.delete', target.id, {
        expectedFolderRevision: 1,
      });
      // Privileged archival fixture does not update updated_at, unlike lifecycle transport.
      expect(
        (
          await owner(
            scope,
            'select updated_at from app.workflows where id=$1',
            [workflow],
          )
        ).rows,
      ).toEqual(before);
    });
    it('fences every changed parent operation, disjoint selection, order and revision before item work', async () => {
      const scope = await fixture.scope(),
        a = await scope.workflow(),
        b = await scope.workflow();
      const key = commandKey(),
        body = {
          operation: 'move',
          folderId: null,
          items: [
            { workflowId: a, expectedOrganizationRevision: 1 },
            { workflowId: b, expectedOrganizationRevision: 1 },
          ],
        };
      expect(await admit(scope, key, body)).toEqual({ admitted: true });
      for (const changed of [
        { operation: 'replace_tags', tagIds: [], items: body.items },
        move(randomUUID()),
        { ...body, items: [...body.items].reverse() },
        {
          ...body,
          items: [
            { workflowId: a, expectedOrganizationRevision: 2 },
            body.items[1],
          ],
        },
      ])
        await expect(admit(scope, key, changed)).rejects.toMatchObject({
          code: 'P7002',
        });
      expect(
        (
          await owner(
            scope,
            'select count(*)::int count from app.workflow_organization_state where workspace_id=$1',
            [scope.workspace],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    });
    it('requires a committed matching admission, member scope, purpose and derived item key', async () => {
      const scope = await fixture.scope(),
        workflow = await scope.workflow(),
        key = commandKey(),
        body = move(workflow);
      await expect(item(scope, key, body, workflow)).rejects.toMatchObject({
        code: 'P7002',
      });
      await expect(
        fixture.transaction(
          fixture.api,
          scope.workspace,
          scope.actor,
          async (client) => {
            await client.query(
              'select app.admit_workflow_organization_batch($1,$2::jsonb)',
              [key, JSON.stringify(body)],
            );
            await client.query(
              'select app.execute_workflow_organization_batch_item($1,$2::jsonb,$3,$4)',
              [key, JSON.stringify(body), workflow, itemKey(key, workflow)],
            );
          },
        ),
      ).rejects.toMatchObject({ code: 'P7002' });
      await expect(
        fixture.transaction(
          fixture.api,
          scope.workspace,
          scope.actor,
          async (client) => {
            await client.query('savepoint admission');
            await client.query(
              'select app.admit_workflow_organization_batch($1,$2::jsonb)',
              [key, JSON.stringify(body)],
            );
            await client.query('release savepoint admission');
            await client.query(
              'select app.execute_workflow_organization_batch_item($1,$2::jsonb,$3,$4)',
              [key, JSON.stringify(body), workflow, itemKey(key, workflow)],
            );
          },
        ),
      ).rejects.toMatchObject({ code: 'P7002' });
      await admit(scope, key, body);
      await expect(
        item(scope, key, body, workflow, scope.builder),
      ).rejects.toMatchObject({ code: 'P7002' });
      await expect(
        item(scope, key, body, workflow, scope.actor, commandKey()),
      ).rejects.toMatchObject({ code: 'P7002' });
      await expect(
        item(
          scope,
          key,
          { operation: 'replace_tags', tagIds: [], items: body.items },
          workflow,
        ),
      ).rejects.toMatchObject({ code: 'P7002' });
      expect(await item(scope, key, body, workflow)).toMatchObject({
        organizationRevision: 2,
        replayed: false,
      });
      expect(await item(scope, key, body, workflow)).toMatchObject({
        organizationRevision: 2,
        replayed: true,
      });
    });
    it('converges concurrent exact claims and rejects competing whole identities', async () => {
      const scope = await fixture.scope(),
        workflow = await scope.workflow(),
        key = commandKey(),
        body = move(workflow);
      expect(
        await Promise.all([admit(scope, key, body), admit(scope, key, body)]),
      ).toEqual([{ admitted: true }, { admitted: true }]);
      const outcomes = await Promise.all([
        item(scope, key, body, workflow),
        item(scope, key, body, workflow),
      ]);
      expect(outcomes.map((result) => result.replayed).sort()).toEqual([
        false,
        true,
      ]);
      const competing = commandKey();
      const claims = await Promise.allSettled([
        admit(scope, competing, move(workflow, 2)),
        admit(scope, competing, move(randomUUID())),
      ]);
      expect(
        claims.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        claims.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
    });
    it('recovers a claim-only boundary through a new connection while writer-OFF never admits new items', async () => {
      const scope = await fixture.scope(),
        workflow = await scope.workflow(),
        key = commandKey(),
        body = move(workflow);
      await admit(scope, key, body); // Committed claim; intentionally no item yet.
      await fixture.owner.query(
        'update app.workflow_organization_rollout set writes_enabled=false',
      );
      try {
        expect(await admit(scope, key, body)).toEqual({ admitted: true });
        await expect(item(scope, key, body, workflow)).rejects.toMatchObject({
          code: 'P7001',
        });
        await expect(admit(scope, commandKey(), body)).rejects.toMatchObject({
          code: 'P7001',
        });
      } finally {
        await fixture.owner.query(
          'update app.workflow_organization_rollout set writes_enabled=true',
        );
      }
      expect(await item(scope, key, body, workflow)).toMatchObject({
        organizationRevision: 2,
      });
      await fixture.owner.query(
        'update app.workflow_organization_rollout set writes_enabled=false',
      );
      try {
        expect(await item(scope, key, body, workflow)).toMatchObject({
          replayed: true,
        });
      } finally {
        await fixture.owner.query(
          'update app.workflow_organization_rollout set writes_enabled=true',
        );
      }
    });
    it('checks current authority before any retained admission or item result', async () => {
      const scope = await fixture.scope(),
        workflow = await scope.workflow(),
        key = commandKey(),
        body = move(workflow);
      await admit(scope, key, body);
      await item(scope, key, body, workflow);
      await owner(
        scope,
        "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
        [scope.workspace, scope.actor],
      );
      await expect(admit(scope, key, body)).rejects.toMatchObject({
        code: '42501',
      });
      await expect(item(scope, key, body, workflow)).rejects.toMatchObject({
        code: '42501',
      });
    });
    it('preserves current archived placement authority on both single and batch replays', async () => {
      const scope = await fixture.scope(),
        single = await scope.workflow(),
        batched = await scope.workflow();
      const singleKey = commandKey(),
        batchKey = commandKey(),
        body = move(batched);
      await place(scope, single, null, 1, singleKey, scope.builder);
      await admit(scope, batchKey, body, scope.builder);
      await item(scope, batchKey, body, batched, scope.builder);
      await fixture.authoring.transitionWorkflowLifecycle({
        workspaceId: scope.workspace,
        actorId: scope.actor,
        workflowId: single,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await fixture.authoring.transitionWorkflowLifecycle({
        workspaceId: scope.workspace,
        actorId: scope.actor,
        workflowId: batched,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await expect(
        place(scope, single, null, 1, singleKey, scope.builder),
      ).rejects.toMatchObject({ code: 'P7009' });
      await expect(
        item(scope, batchKey, body, batched, scope.builder),
      ).rejects.toMatchObject({ code: 'P7009' });
      expect(await place(scope, batched, null, 2)).toMatchObject({
        organizationRevision: 3,
      });
    });
    it('shares parent identity across tag cleanup and bulk replacement without copying placement', async () => {
      const scope = await fixture.scope(),
        workflow = await scope.workflow(),
        target = await create(scope, 'keep placement');
      const tag = (
        await fixture.tags.createTag({
          workspaceId: scope.workspace,
          actorId: scope.actor,
          key: 'batch-tag',
          idempotencyKey: randomUUID(),
        })
      ).tag;
      await place(scope, workflow, target.id);
      const key = commandKey(),
        body = {
          operation: 'replace_tags',
          tagIds: [tag.id],
          items: [{ workflowId: workflow, expectedOrganizationRevision: 2 }],
        };
      await admit(scope, key, body);
      expect(await item(scope, key, body, workflow)).toMatchObject({
        organizationRevision: 3,
      });
      const cleanup = {
        operation: 'tag_cleanup',
        tagId: tag.id,
        items: [{ workflowId: workflow, expectedOrganizationRevision: 3 }],
      };
      await expect(admit(scope, key, cleanup)).rejects.toMatchObject({
        code: 'P7002',
      });
      await expect(
        admit(scope, commandKey(), cleanup, scope.builder),
      ).rejects.toMatchObject({ code: '42501' });
      const cleanupKey = commandKey();
      await admit(scope, cleanupKey, cleanup);
      expect(await item(scope, cleanupKey, cleanup, workflow)).toMatchObject({
        organizationRevision: 4,
      });
      expect(
        (
          await owner(
            scope,
            'select folder_id from app.workflow_organization_state where workflow_id=$1',
            [workflow],
          )
        ).rows,
      ).toEqual([{ folder_id: target.id }]);
    });
    it('expires parent authority and removes it through retention', async () => {
      const scope = await fixture.scope(),
        workflow = await scope.workflow(),
        key = commandKey(),
        body = move(workflow);
      await admit(scope, key, body);
      await owner(
        scope,
        "update app.workflow_organization_receipts set created_at=clock_timestamp()-interval '25 hours',expires_at=clock_timestamp()-interval '1 hour' where workspace_id=$1",
        [scope.workspace],
      );
      await expect(admit(scope, key, body)).rejects.toMatchObject({
        code: 'P7002',
      });
      await expect(item(scope, key, body, workflow)).rejects.toMatchObject({
        code: 'P7002',
      });
      expect(
        (
          await owner(
            scope,
            "select result from app.workflow_organization_receipts where workspace_id=$1 and operation='organization.batch.identity'",
            [scope.workspace],
          )
        ).rows,
      ).toEqual([{ result: { admitted: true } }]);
      expect(
        (await enforceRetention(fixture.urls.maintenance))
          .organization_receipts,
      ).toBeGreaterThanOrEqual(1);
      expect(
        (
          await owner(
            scope,
            'select count(*)::int count from app.workflow_organization_receipts where workspace_id=$1',
            [scope.workspace],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      // Recovery horizon is not an indefinite key fence after authorized expiry.
      expect(
        await admit(scope, key, {
          operation: 'replace_tags',
          tagIds: [],
          items: body.items,
        }),
      ).toEqual({ admitted: true });
    });
    it('keeps folder RLS and helpers read-only/current-scoped for the app role', async () => {
      const scope = await fixture.scope(),
        target = await create(scope, 'private scope'),
        other = await fixture.scope();
      expect(
        await sql(
          scope,
          "select coalesce(jsonb_agg(id),'[]'::jsonb) result from app.workflow_folders",
          [],
          scope.viewer,
        ),
      ).toEqual([target.id]);
      expect(
        await sql(
          other,
          "select coalesce(jsonb_agg(id),'[]'::jsonb) result from app.workflow_folders",
          [],
        ),
      ).toEqual([]);
      await expect(
        folder(
          scope,
          'folder.create',
          null,
          { name: 'denied', parentId: null },
          commandKey(),
          scope.viewer,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        fixture.api.query("update app.workflow_folders set name='forged'"),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        fixture.api.query("select app.workflow_organization_batch_body('{}')"),
      ).rejects.toMatchObject({ code: '42501' });
    });
  },
);
