import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCuratedCutoverArtifact } from './curated-cutover-artifact-build.mjs';
import { createCuratedCutoverResources } from './curated-cutover-owned-resources.mjs';
import {
  curatedDatabaseUrl,
  verifyCuratedFixtureOwnership,
} from './curated-template-owned-fixture.mjs';
import {
  closeOrganizationQualification,
  startOrganizationApi,
} from './organization-process-owner.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const oldRef = '936612f26567f760c83e41c13e4c7fc7b620e69f';
const compatibleRef = '74826ea1c5d2aa8c07d1d0c70edff1889a3fcf71';
async function moduleOf(artifact, specifier) {
  const require = createRequire(
    path.join(artifact.source, 'apps/api/package.json'),
  );
  return import(pathToFileURL(require.resolve(specifier)).href);
}
async function send(url, method = 'GET', body, headers = {}) {
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: {
      origin: 'https://app.integration.test',
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}
function browser(response) {
  const value = (name) => {
    const cookie = response.headers
      .getSetCookie()
      .find((item) => item.startsWith(`${name}=`));
    assert.ok(cookie, 'Real authentication cookie required');
    return cookie.split(';', 1)[0].slice(name.length + 1);
  };
  const csrf = decodeURIComponent(value('pertexo_csrf'));
  return {
    cookie: `pertexo_session=${value('pertexo_session')}; pertexo_csrf=${encodeURIComponent(csrf)}`,
    'x-csrf-token': csrf,
  };
}
const migrationConfig = (connectionString) => ({
  connectionString,
  ownerRole: 'pertexo_owner',
  apiRuntimeRole: 'pertexo_api',
  workerRuntimeRole: 'pertexo_worker',
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
});

test(
  'F07 exact compiled image denial, actual process restart and compatible writer-OFF recovery',
  {
    skip: process.env.F07_PROCESS_OWNED_QUALIFICATION !== 'true',
    timeout: 600000,
  },
  async () => {
    await verifyCuratedFixtureOwnership();
    const artifacts = [],
      processes = [];
    let resources, barrierPool, barrierClient;
    try {
      for (const [label, ref] of [
        ['f07-pre-organization', oldRef],
        ['f07-compatible', compatibleRef],
      ]) {
        const artifact = await buildCuratedCutoverArtifact({
          repository,
          ref,
          label,
        });
        artifacts.push(artifact);
        console.info(
          'F07 exact compiled artifact',
          JSON.stringify(artifact.witness),
        );
      }
      const [old, current] = artifacts;
      const legacyContracts = await moduleOf(
        old,
        '@pertexo/contracts/schemas/workflow-authoring',
      );
      resources = await createCuratedCutoverResources(repository);
      console.info(
        'F07 owned namespace disclosure: reused F06 cutover naming and empty token-fenced Redis DB12; not F06 acceptance evidence',
      );
      const database = await moduleOf(current, '@pertexo/database/testing');
      await database.migrateDatabase(migrationConfig(resources.migrationUrl));
      const ownerQuery = async (sql, values = []) => {
        const client = await resources.inspector.connect();
        try {
          await client.query('begin');
          await client.query('set local role pertexo_owner');
          const result = await client.query(sql, values);
          await client.query('commit');
          return result;
        } finally {
          await client.query('rollback');
          client.release();
        }
      };
      const compatibility = await import(
        pathToFileURL(
          path.join(
            current.source,
            'apps/api/dist/platform/workflow/workflow-compatibility.js',
          ),
        ).href
      );
      const release = compatibility
        .createCoreWorkflowCompatibility('validate_activation')
        .variants.at(-1).compatibilityReleaseDescription;
      await ownerQuery(
        "insert into app.node_compatibility_releases(epoch,schema_version,fingerprint,catalog_json,prepared_by_kind,prepared_by,reason) values($1,1,$2,$3::jsonb,'deployment','owned-f07-process','Frozen compatible profile') on conflict(epoch) do nothing",
        [release.epoch, release.fingerprint, release.catalogJson],
      );
      await ownerQuery(
        'update app.node_compatibility_current set epoch=$1,fingerprint=$2 where singleton',
        [release.epoch, release.fingerprint],
      );
      await ownerQuery(
        'update app.workflow_organization_rollout set writes_enabled=true',
      );
      const refused = await startOrganizationApi(old, resources);
      processes.push(refused);
      assert.deepEqual(
        { phase: refused.phase, reason: refused.reason },
        { phase: 'refused', reason: 'migration-head-incompatible' },
      );
      let api = await startOrganizationApi(current, resources);
      processes.push(api);
      assert.equal(api.phase, 'listening');
      const email = `f07-process-${randomUUID()}@example.test`;
      const credentials = { email, password: 'owned-process-password-12345' };
      assert.equal(
        (
          await send(`${api.url}/v1/auth/sign-up/email`, 'POST', {
            ...credentials,
            name: 'Process Owner',
            callbackURL: '/workspaces',
          })
        ).status,
        200,
      );
      assert.equal((await api.control('verify-email', { email })).status, 302);
      const auth = browser(
        await send(`${api.url}/v1/auth/sign-in/email`, 'POST', credentials),
      );
      const post = (route, body, key = randomUUID()) =>
        send(`${api.url}${route}`, 'POST', body, {
          ...auth,
          'idempotency-key': key,
        });
      const get = (route) => send(`${api.url}${route}`, 'GET', undefined, auth);
      const workspace = await post('/v1/workspaces', {
        name: 'Process Workspace',
        slug: `process-${randomUUID().slice(0, 12)}`,
      });
      assert.equal(workspace.status, 201);
      const workspaceId = workspace.body.id;
      const route = `/v1/workspaces/${workspaceId}`;
      const ids = [];
      for (let index = 0; index < 2; index++) {
        const created = await post(`${route}/workflows`, {
          name: `Workflow ${index}`,
        });
        assert.equal(created.status, 201);
        ids.push(created.body.workflow.id);
      }
      const tag = await post(`${route}/workflow-tags`, { key: 'restart' });
      assert.equal(tag.status, 201);
      const tagged = await post(`${route}/workflows/${ids[0]}/tags`, {
        tagIds: [tag.body.tag.id],
        expectedOrganizationRevision: 1,
      });
      assert.equal(tagged.status, 200);
      const folder = await post(`${route}/workflow-folders`, {
        name: 'Restart Folder',
        parentId: null,
      });
      assert.equal(folder.status, 201);
      const folderId = folder.body.folder.id;
      const projection = await get(
        `${route}/workflows/${ids[0]}?include=organization`,
      );
      assert.equal(projection.status, 200);
      const favoriteKey = randomUUID(),
        favoriteBody = {
          favorite: true,
          expectedFavoriteRevision:
            projection.body.organization.favoriteRevision,
        };
      const favorite = await post(
        `${route}/workflows/${ids[0]}/favorite`,
        favoriteBody,
        favoriteKey,
      );
      assert.equal(favorite.status, 200);
      const bulkKey = randomUUID(),
        bulk = {
          operation: 'move',
          folderId,
          items: [
            { workflowId: ids[0], expectedOrganizationRevision: 2 },
            { workflowId: ids[1], expectedOrganizationRevision: 1 },
          ],
        };
      const { Pool } = (await moduleOf(current, 'pg')).default;
      const owned = await verifyCuratedFixtureOwnership();
      barrierPool = new Pool({
        connectionString: curatedDatabaseUrl(owned.adminUrl, resources.name),
        max: 1,
      });
      barrierClient = await barrierPool.connect();
      await barrierClient.query('begin');
      await barrierClient.query('set local role pertexo_owner');
      await barrierClient.query(
        "select set_config('app.workspace_id',$1,true)",
        [workspaceId],
      );
      const barrierRow = await barrierClient.query(
        'select id from app.workflows where id=$1 for update',
        [ids[1]],
      );
      assert.equal(
        barrierRow.rowCount,
        1,
        'The owner barrier must lock an actual tenant workflow',
      );
      const outstanding = post(
        `${route}/workflows/organization/bulk`,
        bulk,
        bulkKey,
      ).then(
        () => 'reply',
        () => 'connection-lost',
      );
      const parentHash = createHash('sha256').update(bulkKey).digest('hex');
      const until = Date.now() + 10000;
      let committed;
      do {
        committed = await ownerQuery(
          "select (select count(*)::int from app.workflow_organization_receipts where workspace_id=$1 and operation='organization.batch.identity' and key_hash=$2 and result is not null) parents, (select revision::int from app.workflow_organization_state where workspace_id=$1 and workflow_id=$3) revision",
          [workspaceId, parentHash, ids[0]],
        );
        if (committed.rows[0].parents === 1 && committed.rows[0].revision === 3)
          break;
        await resources.inspector.query('select pg_sleep(0.02)');
      } while (Date.now() < until);
      assert.deepEqual(
        committed.rows[0],
        { parents: 1, revision: 3 },
        'Admission and first item committed before process death',
      );
      const oldPid = api.pid;
      assert.equal((await api.kill()).signal, 'SIGKILL');
      assert.equal(await outstanding, 'connection-lost');
      await barrierClient.query('rollback');
      barrierClient.release();
      barrierClient = undefined;
      await barrierPool.end();
      barrierPool = undefined;
      api = await startOrganizationApi(current, resources);
      processes.push(api);
      assert.notEqual(api.pid, oldPid);
      const recoveredPid = api.pid;
      const recovered = await post(
        `${route}/workflows/organization/bulk`,
        bulk,
        bulkKey,
      );
      assert.equal(recovered.status, 200);
      assert.deepEqual(
        recovered.body.items.map(({ workflowId, status, replayed }) => ({
          workflowId,
          status,
          replayed,
        })),
        [
          { workflowId: ids[0], status: 'updated', replayed: true },
          { workflowId: ids[1], status: 'updated', replayed: false },
        ],
      );
      const retained = await get(
        `${route}/workflows/${ids[0]}?include=organization`,
      );
      assert.equal(retained.body.organization.isFavorite, true);
      assert.equal(retained.body.organization.folderId, folderId);
      assert.equal(retained.body.organization.tags[0].id, tag.body.tag.id);
      const claimOnlyKey = randomUUID();
      const claimOnlyBody = {
        operation: 'move',
        folderId: null,
        items: [{ workflowId: ids[1], expectedOrganizationRevision: 2 }],
      };
      const actor = await ownerQuery(
        "select actor_id user_id from app.workflow_organization_receipts where workspace_id=$1 and key_hash=$2 and operation='organization.batch.identity'",
        [workspaceId, parentHash],
      );
      const adapterModule = await moduleOf(current, '@pertexo/database/api');
      const batchAdapter =
        adapterModule.createWorkflowOrganizationBatchDatabase(
          database.parseDatabaseConfig({
            connectionString: resources.apiUrl,
            max: 1,
            ownerRole: 'pertexo_owner',
          }),
        );
      try {
        assert.deepEqual(
          await batchAdapter.admitBatch({
            workspaceId,
            actorId: actor.rows[0].user_id,
            idempotencyKey: claimOnlyKey,
            request: claimOnlyBody,
          }),
          { admitted: true },
        );
      } finally {
        await batchAdapter.close();
      }
      await ownerQuery(
        'update app.workflow_organization_rollout set writes_enabled=false',
      );
      await api.close();
      api = await startOrganizationApi(current, resources);
      processes.push(api);
      assert.equal((await get(`${route}/workflow-folders`)).status, 200);
      assert.equal((await get(`${route}/workflow-tags`)).status, 200);
      const replay = await post(
        `${route}/workflows/organization/bulk`,
        bulk,
        bulkKey,
      );
      assert.equal(replay.status, 200);
      assert.ok(replay.body.items.every((item) => item.replayed));
      assert.equal(
        (
          await post(
            `${route}/workflows/${ids[0]}/favorite`,
            favoriteBody,
            favoriteKey,
          )
        ).body.replayed,
        true,
      );
      assert.equal(
        (
          await post(`${route}/workflow-folders`, {
            name: 'OFF new',
            parentId: null,
          })
        ).status,
        503,
      );
      const freshBulk = await post(`${route}/workflows/organization/bulk`, {
        ...bulk,
        folderId: null,
        items: [{ workflowId: ids[0], expectedOrganizationRevision: 3 }],
      });
      assert.equal(freshBulk.status, 503);
      const admittedOff = await post(
        `${route}/workflows/organization/bulk`,
        claimOnlyBody,
        claimOnlyKey,
      );
      assert.equal(admittedOff.status, 200);
      assert.equal(admittedOff.body.items[0].status, 'unavailable');
      assert.equal(
        (await get(`${route}/workflows/${ids[1]}?include=organization`)).body
          .organization.folderId,
        folderId,
      );
      const legacy = await get(`${route}/workflows/${ids[0]}`);
      assert.equal(legacy.status, 200);
      legacyContracts.workflowSummaryResponseSchema.parse(legacy.body);
      assert.deepEqual(Object.keys(legacy.body), ['workflow']);
      const list = await get(`${route}/workflows`);
      assert.equal(list.status, 200);
      legacyContracts.workflowListResponseSchema.parse(list.body);
      assert.ok(list.body.items.every((item) => !('organization' in item)));
      assert.deepEqual(
        list.body.items.map((item) => item.id).sort(),
        [...ids].sort(),
      );
      const draft = await get(`${route}/workflows/${ids[0]}/draft`);
      assert.equal(draft.status, 200);
      const portability = await moduleOf(
        current,
        '@pertexo/contracts/workflow-portability',
      );
      const exported = await send(
        `${api.url}${route}/workflows/${ids[0]}/export`,
        'POST',
        {
          source: { kind: 'draft' },
          reviewedGraphDigest: await portability.portableGraphDigest(
            draft.body.graph,
          ),
        },
        { ...auth, 'if-match': draft.headers.get('etag') },
      );
      assert.equal(exported.status, 200);
      assert.ok(!JSON.stringify(exported.body).includes('organization'));
      const duplicate = await send(
        `${api.url}${route}/workflows/${ids[0]}/duplicate`,
        'POST',
        { name: 'OFF duplicate', source: { kind: 'draft' } },
        {
          ...auth,
          'if-match': draft.headers.get('etag'),
          'idempotency-key': randomUUID(),
        },
      );
      assert.equal(duplicate.status, 201);
      const duplicateProjection = await get(
        `${route}/workflows/${duplicate.body.workflowId}?include=organization`,
      );
      assert.equal(duplicateProjection.body.organization.folderId, null);
      assert.deepEqual(duplicateProjection.body.organization.tags, []);
      assert.equal(duplicateProjection.body.organization.isFavorite, false);
      const preview = await post(`${route}/workflows/import/preview`, {
        manifest: exported.body,
        bindings: [],
      });
      assert.equal(preview.status, 200);
      await ownerQuery(
        'update app.workflow_portability_rollout set import_enabled=true where singleton',
      );
      const imported = await post(`${route}/workflows/import`, {
        manifest: exported.body,
        bindings: [],
        name: 'OFF import',
        expectedCompatibilityFingerprint: preview.body.compatibilityFingerprint,
      });
      assert.equal(imported.status, 201);
      const importedProjection = await get(
        `${route}/workflows/${imported.body.workflowId}?include=organization`,
      );
      assert.equal(importedProjection.body.organization.folderId, null);
      assert.deepEqual(importedProjection.body.organization.tags, []);
      assert.equal(importedProjection.body.organization.isFavorite, false);
      const archived = await post(`${route}/workflows/${ids[0]}/archive`, {
        expectedLifecycleRevision: 1,
      });
      assert.equal(archived.status, 202);
      assert.equal(
        (
          await post(`${route}/workflows/${ids[0]}/restore`, {
            expectedLifecycleRevision: 2,
          })
        ).status,
        202,
      );
      console.info(
        'F07 actual process qualification',
        JSON.stringify({
          oldRef,
          compatibleRef,
          terminatedPid: oldPid,
          restartedPid: recoveredPid,
          writerOffPid: api.pid,
          committedParentBeforeDeath: true,
          exactWholeParentRecovery: true,
          writerOffReplay: true,
        }),
      );
    } finally {
      // No resource teardown after an unconfirmed process shutdown.
      await Promise.all(processes.map((owned) => owned.close()));
      if (barrierClient) {
        await barrierClient.query('rollback');
        barrierClient.release();
      }
      await barrierPool?.end();
      await closeOrganizationQualification([], resources, artifacts);
    }
  },
);
