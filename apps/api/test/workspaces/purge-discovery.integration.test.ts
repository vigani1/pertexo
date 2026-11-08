import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store/server';
import { createWorkspacePurgeCoordinator } from '@pertexo/core/lifecycle';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(
  betterAuthIntegrationEnabled &&
    process.env.ARTIFACT_STORE_INTEGRATION === 'true',
)('API discovery across real workspace erasure', () => {
  let maintenanceUrl = '';
  const api = useBetterAuthRealApi('purge_discovery', {
    afterMigration: (url) => {
      maintenanceUrl = url(process.env.DATABASE_MAINTENANCE_URL ?? '');
      return Promise.resolve();
    },
  });
  it('keeps current members informed until rows and stored objects are gone without disclosing the workspace to outsiders', async () => {
    const ownerEmail = `${randomUUID()}@example.test`;
    const memberEmail = `${randomUUID()}@example.test`;
    const outsiderEmail = `${randomUUID()}@example.test`;
    for (const email of [ownerEmail, memberEmail, outsiderEmail])
      await api.signUp(email, '/workspaces');
    let owner = await api.signIn(ownerEmail);
    let member = await api.signIn(memberEmail);
    const outsider = await api.signIn(outsiderEmail);
    const created = await api.send('POST', '/v1/workspaces', {
      browser: owner,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Erasure visibility',
        slug: `erase-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(created.statusCode, created.payload).toBe(201);
    const workspaceId = created.json<{ id: string }>().id;
    const db = api.database();
    await db.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) select $1,id,'viewer','active' from app.users where email=$2",
      [workspaceId, memberEmail],
    );
    await db.query(
      "insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,1,'{}')",
      [workspaceId],
    );
    await db.query(
      "update app.workspaces set status='pending_deletion',deletion_requested_at=clock_timestamp()-interval '31 days',deletion_requested_by=created_by,deletion_reason='Test erasure',purge_after=clock_timestamp()-interval '1 day' where id=$1",
      [workspaceId],
    );
    const store = createArtifactStore(parseArtifactStoreConfig());
    const identity = { workspaceId, artifactId: randomUUID() };
    const body = Buffer.from('Object must disappear before deletion finishes');
    const reachedObjects = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const purge = createWorkspacePurgeCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      {
        async purgeWorkspacePage(input) {
          reachedObjects.resolve(undefined);
          await resume.promise;
          return store.purgeWorkspacePage(input);
        },
      },
    );
    let pending: Promise<unknown> | undefined;
    async function discover(browser: typeof owner) {
      const response = await api.send('GET', '/v1/workspaces', { browser });
      expect(response.statusCode, response.payload).toBe(200);
      return response.json<{
        items: { id: string; status: string; capabilities: string[] }[];
      }>().items;
    }
    try {
      await store.put({
        ...identity,
        body: Readable.from([body]),
        byteLength: body.length,
        mediaType: 'text/plain',
        sha256: createHash('sha256').update(body).digest('hex'),
      });
      expect(await purge.processNext()).toMatchObject({
        status: 'started',
        workspaceId,
      });
      for (let i = 0; i < 100; i++) {
        const next = purge.processNext();
        const result = await Promise.race([
          next,
          reachedObjects.promise.then(() => 'objects' as const),
        ]);
        if (result === 'objects') {
          pending = next;
          break;
        }
      }
      expect(pending).toBeDefined();
      expect(
        (
          await db.query(
            'select revision from app.workspace_variable_set_revisions where workspace_id=$1',
            [workspaceId],
          )
        ).rows,
      ).toEqual([]);
      expect(await store.head(identity)).not.toBeNull();
      // Lifecycle transitions revoke sessions; a fresh sign-in must still find
      // current membership while erasure is in progress.
      owner = await api.signIn(ownerEmail);
      member = await api.signIn(memberEmail);
      for (const browser of [owner, member]) {
        expect(await discover(browser)).toContainEqual(
          expect.objectContaining({
            id: workspaceId,
            status: 'purging',
          }),
        );
      }
      expect(await discover(outsider)).toEqual([]);
      for (const browser of [member, outsider]) {
        const refused = await api.send(
          'GET',
          `/v1/workspaces/${workspaceId}/variables`,
          { browser },
        );
        expect(refused.statusCode, refused.payload).toBe(404);
        expect(refused.json()).toMatchObject({ code: 'resource.not_found' });
      }
      resume.resolve(undefined);
      await pending;
      let completed = false;
      for (let i = 0; i < 10; i++) {
        if ((await purge.processNext()).status === 'completed') {
          completed = true;
          break;
        }
      }
      expect(completed).toBe(true);
      expect(await store.head(identity)).toBeNull();
      expect(
        (
          await db.query('select status from app.workspaces where id=$1', [
            workspaceId,
          ])
        ).rows,
      ).toEqual([{ status: 'deleted' }]);
      expect(
        (
          await db.query(
            'select user_id from app.workspace_memberships where workspace_id=$1',
            [workspaceId],
          )
        ).rows,
      ).toEqual([]);
      for (const browser of [owner, member, outsider])
        expect(await discover(browser)).toEqual([]);
      expect(await discover(await api.signIn(ownerEmail))).toEqual([]);
    } finally {
      resume.resolve(undefined);
      await pending?.catch(() => undefined);
      await purge.close();
      await store.delete(identity);
      store.close();
    }
  }, 60_000);
});
