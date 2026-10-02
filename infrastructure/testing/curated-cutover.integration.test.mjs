import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCuratedCutoverArtifact } from './curated-cutover-artifact-build.mjs';
import { createCuratedCutoverResources } from './curated-cutover-owned-resources.mjs';
import { startCuratedCutoverApi } from './curated-cutover-process-owner.mjs';
import { createCuratedCutoverTraffic } from './curated-cutover-traffic.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const oldRef = 'f543283825887165889f7520655558b2a3f9229c';
const enabled = process.env.F06_CUTOVER_OWNED_FIXTURE === 'true';
const origin = 'https://app.integration.test';
async function artifactPackage(artifact, specifier) {
  const require = createRequire(
    path.join(artifact.source, 'apps/api/package.json'),
  );
  return import(pathToFileURL(require.resolve(specifier)).href);
}
async function artifactModule(artifact, relative) {
  return import(pathToFileURL(path.join(artifact.source, relative)).href);
}
async function reply(url, method = 'GET', payload, headers = {}) {
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    headers: {
      origin,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length ? JSON.parse(text) : null,
  };
}
function browserHeaders(response) {
  const cookies = response.headers.getSetCookie();
  const find = (name) => {
    const cookie = cookies.find((value) => value.startsWith(`${name}=`));
    assert.ok(cookie, `${name} real auth cookie`);
    return cookie.split(';', 1)[0].slice(name.length + 1);
  };
  const session = find('pertexo_session'),
    csrf = decodeURIComponent(find('pertexo_csrf'));
  return {
    cookie: `pertexo_session=${session}; pertexo_csrf=${encodeURIComponent(csrf)}`,
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
  'owned full compiled API held-traffic cutover and separately built compatible-off rollback',
  { skip: !enabled, timeout: 600000 },
  async (t) => {
    const compatibleRef = process.env.F06_CUTOVER_COMPATIBLE_SOURCE;
    assert.match(
      compatibleRef ?? '',
      /^[a-f0-9]{40}$/u,
      'Root must supply exact post-fix frozen compatible source',
    );
    assert.equal(
      execFileSync('git', ['rev-parse', `${compatibleRef}^{commit}`], {
        cwd: repository,
        encoding: 'utf8',
      }).trim(),
      compatibleRef,
    );
    const artifacts = [],
      processes = [];
    let resources, traffic, mainFailure;
    let failed = false;
    const stop = async (process) => {
      await process.close();
    };
    try {
      for (const [label, ref] of [
        ['pre-origin', oldRef],
        ['compatible-current', compatibleRef],
        ['compatible-off-rollback', compatibleRef],
      ]) {
        const artifact = await buildCuratedCutoverArtifact({
          repository,
          ref,
          label,
        });
        artifacts.push(artifact);
        console.info(
          'F06 independently built source artifact',
          JSON.stringify(artifact.witness),
        );
      }
      const [old, current, rollback] = artifacts;
      assert.notEqual(current.source, rollback.source);
      assert.equal(current.witness.sourceDigest, rollback.witness.sourceDigest);
      const childHarnessDigest = createHash('sha256')
        .update(
          await readFile(
            new URL('./curated-cutover-api-process.mjs', import.meta.url),
          ),
        )
        .digest('hex');
      const migrationDigest = createHash('sha256')
        .update(
          await readFile(
            path.join(
              current.source,
              'packages/database/migrations/0133_curated_template_origin.sql',
            ),
          ),
        )
        .digest('hex');
      assert.equal(
        migrationDigest,
        '2b2a99f8237d64dd64a19b0b12551ccf72338205de8f360e4d4c6f883356a393',
      );
      console.info(
        'F06 cutover source witnesses',
        JSON.stringify({
          childHarnessDigest,
          migrationDigest,
          node: process.version,
          compatibleRef,
          oldRef,
        }),
      );
      const oldDatabase = await artifactPackage(
          old,
          '@pertexo/database/testing',
        ),
        currentDatabase = await artifactPackage(
          current,
          '@pertexo/database/testing',
        );
      const oldContract = await artifactPackage(
        old,
        '@pertexo/contracts/schemas/workflow-authoring',
      );
      const contracts = await artifactPackage(
        current,
        '@pertexo/contracts/schemas/workflow-authoring',
      );
      const { createCoreWorkflowCompatibility } = await artifactModule(
        old,
        'apps/api/dist/platform/workflow/workflow-compatibility.js',
      );
      const profile = createCoreWorkflowCompatibility(
        'validate_activation',
      ).variants.at(-1);
      assert.ok(profile);
      resources = await createCuratedCutoverResources(repository);
      await oldDatabase.migrateDatabase(
        migrationConfig(resources.migrationUrl),
      );
      const ownerQuery = async (sql, values = []) => {
        const client = await resources.inspector.connect();
        try {
          await client.query('begin');
          await client.query('set local role pertexo_owner');
          const result = await client.query(sql, values);
          await client.query('commit');
          return result;
        } finally {
          try {
            await client.query('rollback');
          } finally {
            client.release();
          }
        }
      };
      const release = profile.compatibilityReleaseDescription;
      const { CURATED_WORKFLOW_TEMPLATES } = await artifactPackage(
        current,
        '@pertexo/workflow-model/curated-templates',
      );
      const template = CURATED_WORKFLOW_TEMPLATES[0];
      assert.ok(template);
      const originCommand = {
          manifest: template.manifest,
          bindings: [],
          name: 'Accepted reviewed local origin',
          expectedCompatibilityFingerprint: release.fingerprint,
          templateOrigin: {
            schemaVersion: 1,
            templateId: template.templateId,
            templateVersion: template.templateVersion,
            baseManifestDigest: template.baseManifestDigest,
          },
        },
        originKey = randomUUID();
      console.info('F06 old parser and retained replay body witness', {
        originCommandJsonSha256: createHash('sha256')
          .update(JSON.stringify(originCommand))
          .digest('hex'),
        oldParserSource: oldRef,
      });
      await ownerQuery(
        "insert into app.node_compatibility_releases(epoch,schema_version,fingerprint,catalog_json,prepared_by_kind,prepared_by,reason) values($1,1,$2,$3::jsonb,'deployment','owned-cutover','Source-bound supported-profile fixture') on conflict(epoch) do nothing",
        [release.epoch, release.fingerprint, release.catalogJson],
      );
      await ownerQuery(
        'update app.node_compatibility_current set epoch=$1,fingerprint=$2 where singleton',
        [release.epoch, release.fingerprint],
      );
      await ownerQuery(
        'update app.workflow_portability_rollout set import_enabled=true where singleton',
      );
      traffic = await createCuratedCutoverTraffic();
      let oldProcess = await startCuratedCutoverApi(
        old,
        resources.apiUrl,
        resources.redisUrl,
      );
      processes.push(oldProcess);
      await traffic.release(oldProcess.url);
      const send = (method, route, payload, headers) =>
        reply(new URL(route, traffic.url), method, payload, headers);
      const email = `cutover-${randomUUID()}@example.test`,
        password = 'a long enough integration password';
      assert.equal(
        (
          await send('POST', '/v1/auth/sign-up/email', {
            name: 'Owned cutover builder',
            email,
            password,
            callbackURL: '/workspaces',
          })
        ).status,
        200,
      );
      const verification = (await oldProcess.control('mail', { email })).find(
        (message) => message.purpose === 'verification',
      );
      assert.ok(verification);
      const verificationUrl = new URL(verification.url);
      assert.equal(
        (await send('GET', verificationUrl.pathname + verificationUrl.search))
          .status,
        302,
      );
      const signedIn = await send('POST', '/v1/auth/sign-in/email', {
        email,
        password,
        callbackURL: '/workspaces',
      });
      assert.equal(signedIn.status, 200);
      const browser = browserHeaders(signedIn);
      const createdWorkspace = await send(
        'POST',
        '/v1/workspaces',
        {
          name: 'Held-traffic owned qualification',
          slug: `cutover-${randomUUID()}`,
        },
        { ...browser, 'idempotency-key': randomUUID() },
      );
      assert.equal(createdWorkspace.status, 201);
      const workspaceId = createdWorkspace.body.id,
        scope = `/v1/workspaces/${workspaceId}/workflows`;
      const { projectWorkflowPortableManifest } = await artifactPackage(
        old,
        '@pertexo/workflow-model/portability',
      );
      const { canonicalWorkflowPortableJson } = await artifactPackage(
        old,
        '@pertexo/workflow-model/portability-contract',
      );
      const manifest = projectWorkflowPortableManifest(
        { schemaVersion: 1, nodes: [], edges: [], settings: {} },
        profile.portableCatalog,
      );
      const ordinary = {
          manifest,
          bindings: [],
          name: 'Retained ordinary source',
          expectedCompatibilityFingerprint: release.fingerprint,
        },
        ordinaryKey = randomUUID();
      let ordinaryId, ordinaryHash;
      await t.test(
        'unmodified pre-origin compiled bootstrap serves real BetterAuth ordinary import/default read',
        async () => {
          const imported = await send('POST', `${scope}/import`, ordinary, {
            ...browser,
            'idempotency-key': ordinaryKey,
          });
          assert.equal(imported.status, 201);
          ordinaryId = imported.body.workflowId;
          const summary = await send(
            'GET',
            `${scope}/${ordinaryId}`,
            undefined,
            browser,
          );
          assert.equal(summary.status, 200);
          oldContract.workflowSummaryResponseSchema.parse(summary.body);
          assert.equal('templateOrigin' in summary.body, false);
          assert.equal(
            (
              await send('POST', `${scope}/import`, originCommand, {
                ...browser,
                'idempotency-key': originKey,
              })
            ).status,
            400,
          );
          ordinaryHash = (
            await resources.inspector.query(
              "select request_hash from app.idempotency_records where workspace_id=$1 and operation='workflow.import' and resource_id=$2",
              [workspaceId, ordinaryId],
            )
          ).rows[0].request_hash;
          assert.equal(
            ordinaryHash,
            createHash('sha256')
              .update(canonicalWorkflowPortableJson(ordinary))
              .digest('hex'),
          );
        },
      );
      await t.test(
        'held admission drains and closes old process and API pools before migration',
        async () => {
          await traffic.hold();
          assert.equal(
            (await send('GET', `${scope}/${ordinaryId}`, undefined, browser))
              .status,
            503,
          );
          assert.equal(traffic.snapshot().active, 0);
          await oldProcess.control('drain');
          assert.equal(
            (await reply(new URL('/health/ready', oldProcess.url))).status,
            503,
          );
          await stop(oldProcess);
          assert.equal(
            (
              await resources.inspector.query(
                "select count(*)::int count from pg_stat_activity where datname=$1 and usename='pertexo_api'",
                [resources.name],
              )
            ).rows[0].count,
            0,
          );
          await ownerQuery(
            'update app.workflow_portability_rollout set import_enabled=false where singleton',
          );
        },
      );
      await t.test(
        'real migration failure rolls back partial install and leaves traffic held',
        async () => {
          await ownerQuery(
            'create table app.workflow_template_origins(fixture_collision boolean)',
          );
          try {
            await assert.rejects(
              currentDatabase.migrateDatabase(
                migrationConfig(resources.migrationUrl),
              ),
            );
          } finally {
            await ownerQuery('drop table app.workflow_template_origins');
          }
          assert.equal(
            (
              await resources.inspector.query(
                'select name from pertexo_internal.schema_migrations order by name desc limit 1',
              )
            ).rows[0].name,
            '0132_workflow_portability.sql',
          );
          assert.equal(
            (
              await resources.inspector.query(
                "select to_regclass('app.curated_template_descriptors') relation",
              )
            ).rows[0].relation,
            null,
          );
          assert.equal(traffic.snapshot().held, true);
          assert.equal(
            (await send('GET', `${scope}/${ordinaryId}`, undefined, browser))
              .status,
            503,
          );
        },
      );
      await currentDatabase.migrateDatabase(
        migrationConfig(resources.migrationUrl),
      );
      await t.test(
        'unmodified old compiled bootstrap rejects new head before listening or receiving held traffic',
        async () => {
          await assert.rejects(
            startCuratedCutoverApi(old, resources.apiUrl, resources.redisUrl),
            /Database migration head is incompatible/,
          );
          assert.equal(traffic.snapshot().held, true);
          const forwarded = traffic.snapshot().forwarded;
          assert.equal(
            (await send('GET', `${scope}/${ordinaryId}`, undefined, browser))
              .status,
            503,
          );
          assert.equal(traffic.snapshot().forwarded, forwarded);
        },
      );
      let currentProcess = await startCuratedCutoverApi(
        current,
        resources.apiUrl,
        resources.redisUrl,
      );
      processes.push(currentProcess);
      let originId;
      await t.test(
        'source-bound compatible/off readiness releases held HTTP; strict defaults and ordinary retained replay remain',
        async () => {
          assert.equal(
            (
              await resources.inspector.query(
                'select import_enabled from app.curated_template_rollout where singleton',
              )
            ).rows[0].import_enabled,
            false,
          );
          await traffic.release(currentProcess.url);
          const summary = await send(
            'GET',
            `${scope}/${ordinaryId}`,
            undefined,
            browser,
          );
          assert.equal(summary.status, 200);
          oldContract.workflowSummaryResponseSchema.parse(summary.body);
          const replay = await send('POST', `${scope}/import`, ordinary, {
            ...browser,
            'idempotency-key': ordinaryKey,
          });
          assert.equal(replay.status, 201);
          assert.equal(replay.body.workflowId, ordinaryId);
          assert.equal(
            (
              await send('POST', `${scope}/import`, ordinary, {
                ...browser,
                'idempotency-key': randomUUID(),
              })
            ).status,
            503,
          );
          assert.equal(
            (
              await send('POST', `${scope}/import`, originCommand, {
                ...browser,
                'idempotency-key': originKey,
              })
            ).status,
            503,
          );
          const projection = await send(
            'GET',
            `${scope}/${ordinaryId}?include=templateOrigin`,
            undefined,
            browser,
          );
          contracts.workflowTemplateOriginProjectionResponseSchema.parse(
            projection.body,
          );
          assert.equal(projection.body.templateOrigin, null);
        },
      );
      const duplicate = async (id, key = randomUUID()) => {
        const draft = await send(
          'GET',
          `${scope}/${id}/draft`,
          undefined,
          browser,
        );
        assert.equal(draft.status, 200);
        const result = await send(
          'POST',
          `${scope}/${id}/duplicate`,
          {
            name: 'Qualified unchanged duplication',
            source: { kind: 'draft' },
          },
          {
            ...browser,
            'idempotency-key': key,
            'if-match': draft.headers.get('etag'),
          },
        );
        assert.equal(result.status, 201);
        oldContract.workflowDuplicateResponseSchema.parse(result.body);
        return result.body.workflowId;
      };
      await t.test(
        'compatible/off unchanged duplicate code supports ordinary no-origin source',
        async () => {
          const copy = await duplicate(ordinaryId);
          const projection = await send(
            'GET',
            `${scope}/${copy}?include=templateOrigin`,
            undefined,
            browser,
          );
          assert.equal(projection.status, 200);
          assert.equal(projection.body.templateOrigin, null);
        },
      );
      await t.test(
        'explicit reviewed owned writer enable accepts genuine origin through real HTTP authority',
        async () => {
          await ownerQuery(
            'update app.workflow_portability_rollout set import_enabled=true where singleton',
          );
          await ownerQuery(
            'update app.curated_template_rollout set import_enabled=true where singleton',
          );
          const accepted = await send(
            'POST',
            `${scope}/import`,
            originCommand,
            { ...browser, 'idempotency-key': originKey },
          );
          assert.equal(accepted.status, 201);
          originId = accepted.body.workflowId;
          const projection = await send(
            'GET',
            `${scope}/${originId}?include=templateOrigin`,
            undefined,
            browser,
          );
          assert.equal(projection.status, 200);
          contracts.workflowTemplateOriginProjectionResponseSchema.parse(
            projection.body,
          );
          assert.equal(projection.body.templateOrigin.derivation, 'direct');
        },
      );
      await t.test(
        'disable first, hold/drain, retire selection, restart independently built compatible-off rollback',
        async () => {
          await ownerQuery(
            'update app.curated_template_rollout set import_enabled=false where singleton',
          );
          await ownerQuery(
            'update app.workflow_portability_rollout set import_enabled=false where singleton',
          );
          await traffic.hold();
          await currentProcess.control('drain');
          await stop(currentProcess);
          await ownerQuery(
            'update app.curated_template_descriptors set selection_enabled=false',
          );
          currentProcess = await startCuratedCutoverApi(
            rollback,
            resources.apiUrl,
            resources.redisUrl,
          );
          processes.push(currentProcess);
          await traffic.release(currentProcess.url);
        },
      );
      await t.test(
        'separate rollback image preserves authenticated retained origin replay/read/default/inheritance and denies new template',
        async () => {
          const replay = await send('POST', `${scope}/import`, originCommand, {
            ...browser,
            'idempotency-key': originKey,
          });
          assert.equal(replay.status, 201);
          assert.equal(replay.body.workflowId, originId);
          const defaultRead = await send(
            'GET',
            `${scope}/${originId}`,
            undefined,
            browser,
          );
          assert.equal(defaultRead.status, 200);
          oldContract.workflowSummaryResponseSchema.parse(defaultRead.body);
          assert.equal('templateOrigin' in defaultRead.body, false);
          const direct = await send(
            'GET',
            `${scope}/${originId}?include=templateOrigin`,
            undefined,
            browser,
          );
          assert.equal(direct.status, 200);
          assert.equal(direct.body.templateOrigin.derivation, 'direct');
          // The unmodified pre-origin image is not a rollback target: after
          // genuine origin storage it still refuses the new head before a
          // listener exists. Its exact-body parser witness is from 0132 above.
          await assert.rejects(
            startCuratedCutoverApi(old, resources.apiUrl, resources.redisUrl),
            /Database migration head is incompatible/,
          );
          const copy = await duplicate(originId);
          const inherited = await send(
            'GET',
            `${scope}/${copy}?include=templateOrigin`,
            undefined,
            browser,
          );
          assert.equal(inherited.status, 200);
          assert.deepEqual(inherited.body.templateOrigin, {
            ...direct.body.templateOrigin,
            derivation: 'inherited',
          });
          assert.equal(
            (
              await send('POST', `${scope}/import`, originCommand, {
                ...browser,
                'idempotency-key': randomUUID(),
              })
            ).status,
            503,
          );
          const actor = (
            await resources.inspector.query(
              'select id from app.users where email=$1',
              [email],
            )
          ).rows[0].id;
          await resources.inspector.query(
            "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
            [workspaceId, actor],
          );
          // Workflow authority deliberately hides inaccessible workspace data.
          // The existing read and retained-import contracts both return 404,
          // rather than revealing a suspended membership through a 403.
          assert.equal(
            (
              await send(
                'GET',
                `${scope}/${originId}?include=templateOrigin`,
                undefined,
                browser,
              )
            ).status,
            404,
          );
          assert.equal(
            (
              await send('POST', `${scope}/import`, originCommand, {
                ...browser,
                'idempotency-key': originKey,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await resources.inspector.query(
                'select origin from app.workflow_template_origins where workspace_id=$1 and workflow_id=$2',
                [workspaceId, originId],
              )
            ).rows.length,
            1,
          );
        },
      );
      await traffic.hold();
      await stop(currentProcess);
      assert.equal(
        (
          await resources.inspector.query(
            "select count(*)::int count from pg_stat_activity where datname=$1 and usename='pertexo_api'",
            [resources.name],
          )
        ).rows[0].count,
        0,
      );
    } catch (error) {
      mainFailure = error;
      failed = true;
    }
    const failures = [];
    for (const child of processes.toReversed())
      try {
        await child.close();
      } catch (error) {
        failures.push(error);
      }
    if (traffic)
      try {
        await traffic.close();
      } catch (error) {
        failures.push(error);
      }
    if (resources)
      try {
        await resources.close();
      } catch (error) {
        failures.push(error);
      }
    for (const artifact of artifacts.toReversed())
      try {
        await artifact.close();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(
        [...(failed ? [mainFailure] : []), ...failures],
        'Owned source cutover teardown failed',
      );
    if (failed) throw mainFailure;
  },
);
