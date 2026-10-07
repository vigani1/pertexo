import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createApiConnectionDatabase,
  createIdentityWorkspaceDatabase,
} from '@pertexo/database/api';
import {
  parseDatabaseConfig,
  WorkflowNotFoundError,
  checkDatabaseReadiness,
} from '@pertexo/database/testing';
import {
  CURATED_WORKFLOW_TEMPLATES,
  workflowTemplateOriginRequestSchema,
} from '@pertexo/workflow-model/curated-templates';
import {
  canonicalWorkflowPortableJson,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model/portability-contract';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/graph';
import {
  createCoreWorkflowAuthoringDatabase,
  createCoreWorkflowCompatibility,
} from '../src/platform/workflow/workflow-compatibility.js';
import { createCuratedOriginOwnedDatabase } from './support/curated-origin-owned-database.js';

const corpus = z
  .array(
    z.object({ name: z.string(), value: z.unknown(), accepted: z.boolean() }),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../../../packages/workflow-model/test/fixtures/curated-https-endpoint-v1-corpus.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
const fixture = createCuratedOriginOwnedDatabase();
const actorId = randomUUID();
const compatibility = createCoreWorkflowCompatibility('validate_activation');
const selected = compatibility.variants.at(-1);
if (selected === undefined)
  throw new Error('Actual registered qualification cohort unavailable');
const profile = selected;
let workspaceId = '';
let owner: Pool, api: Pool, worker: Pool;
let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;
let authoring: ReturnType<typeof createCoreWorkflowAuthoringDatabase>;
const resources: { close(): Promise<void> }[] = [];
const connections: Record<string, string> = {};

async function ownerQuery(
  sql: string,
  values: unknown[] = [],
  scope = workspaceId,
) {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout='5s'");
    await client.query('set local role pertexo_owner');
    await client.query(
      "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [scope, actorId],
    );
    const result = await client.query<Record<string, unknown>>(sql, values);
    await client.query('commit');
    return result;
  } finally {
    await client.query('rollback');
    client.release();
  }
}
async function facts() {
  return (
    await ownerQuery(
      `select (select count(*)::int from app.workflows where workspace_id=$1) workflows,
    (select count(*)::int from app.workflow_drafts where workspace_id=$1) drafts,
    (select count(*)::int from app.workflow_template_origins where workspace_id=$1) origins,
    (select count(*)::int from app.idempotency_records where workspace_id=$1 and operation='workflow.import') receipts,
    (select count(*)::int from app.audit_events where workspace_id=$1 and action='workflow.imported') audits`,
      [workspaceId],
    )
  ).rows;
}
function command(
  index = 2,
  endpoint: unknown = 'https://f06-controlled.example.test/result',
) {
  const template = CURATED_WORKFLOW_TEMPLATES[index];
  if (template === undefined) throw new Error('Reviewed template unavailable');
  const manifest = workflowPortableManifestSchema.parse({
    ...template.manifest,
    graph: {
      ...template.manifest.graph,
      nodes: template.manifest.graph.nodes.map((node) => {
        if (index === 2 && node.id === 'controlled-http')
          return { ...node, config: { ...node.config, url: endpoint } };
        if (index === 2 && node.id === 'slack-notification')
          return {
            ...node,
            inputMappings: {
              ...node.inputMappings,
              channelId: { kind: 'literal', value: 'CF06QUALIFY' },
            },
          };
        return node;
      }),
    },
  });
  return {
    workspaceId,
    actorId,
    manifest,
    bindings: manifest.connectionSlots.map((slot) => ({
      nodeId: slot.nodeId,
      slot: slot.slot,
      connectionId: connections[slot.providerKey] ?? randomUUID(),
    })),
    name: 'Owned guard-accepted fixture',
    expectedCompatibilityFingerprint:
      profile.compatibilityReleaseDescription.fingerprint,
    idempotencyKey: randomUUID(),
    templateOrigin: workflowTemplateOriginRequestSchema.parse({
      schemaVersion: template.schemaVersion,
      templateId: template.templateId,
      templateVersion: template.templateVersion,
      baseManifestDigest: template.baseManifestDigest,
    }),
  };
}
function publicCommand(input: ReturnType<typeof command>) {
  return {
    manifest: input.manifest,
    bindings: input.bindings,
    name: input.name,
    expectedCompatibilityFingerprint: input.expectedCompatibilityFingerprint,
    templateOrigin: input.templateOrigin,
  };
}
async function rawAttempt(
  input: ReturnType<typeof command>,
  graphOverride?: unknown,
  textOverride?: string,
  claimHashOverride?: string,
  afterCreate?: (client: PoolClient) => Promise<void>,
) {
  const before = await facts();
  const client = await api.connect();
  try {
    await client.query('begin');
    await client.query(
      "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [workspaceId, actorId],
    );
    const destination = randomUUID();
    const keyHash = createHash('sha256')
      .update(input.idempotencyKey)
      .digest('hex');
    const text =
      textOverride ?? canonicalWorkflowPortableJson(publicCommand(input));
    const hash = createHash('sha256').update(text).digest('hex');
    await client.query(
      "insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref) values($1,$2,'workflow.import',$3,$4,$5,'in_progress',$6,'{}')",
      [
        randomUUID(),
        workspaceId,
        actorId,
        keyHash,
        claimHashOverride ?? hash,
        destination,
      ],
    );
    // Materialization is mechanical slot binding, not an API boolean passed to SQL.
    const boundGraph = structuredClone(input.manifest.graph);
    for (const binding of input.bindings) {
      const node = boundGraph.nodes.find((item) => item.id === binding.nodeId);
      if (node === undefined) throw new Error('Fixture binding target missing');
      Object.assign(node, {
        connectionRefs: {
          ...node.connectionRefs,
          [binding.slot]: binding.connectionId,
        },
      });
    }
    const graph = graphOverride ?? boundGraph;
    await client.query(
      'select app.create_workflow_import_draft($1,$2,$3,$4::jsonb,$5,$6,$7)',
      [
        destination,
        workspaceId,
        actorId,
        JSON.stringify(graph),
        keyHash,
        hash,
        text,
      ],
    );
    const origin = await client.query<{ origin: unknown }>(
      'select origin from app.workflow_template_origins where workspace_id=$1 and workflow_id=$2',
      [workspaceId, destination],
    );
    expect(origin.rows[0]?.origin).toEqual({
      ...input.templateOrigin,
      creationCommandDigest: hash,
      derivation: 'direct',
    });
    await afterCreate?.(client);
  } finally {
    await client.query('rollback');
    client.release();
    expect(await facts()).toEqual(before);
  }
}

describe.skipIf(process.env.F06_ORIGIN_GUARD_OWNED_FIXTURE !== 'true')(
  'genuine F06 guard acceptance on owned PostgreSQL only',
  () => {
    beforeAll(async () => {
      try {
        await fixture.create();
        owner = new Pool({
          connectionString: fixture.migrationUrl,
          max: 4,
          connectionTimeoutMillis: 3000,
        });
        api = new Pool({
          connectionString: fixture.apiUrl,
          max: 2,
          connectionTimeoutMillis: 3000,
        });
        worker = new Pool({
          connectionString: fixture.workerUrl,
          max: 1,
          connectionTimeoutMillis: 3000,
        });
        resources.push(
          { close: () => owner.end() },
          { close: () => api.end() },
          { close: () => worker.end() },
        );
        const config = parseDatabaseConfig({
          connectionString: fixture.apiUrl,
          max: 2,
        });
        identity = createIdentityWorkspaceDatabase(config);
        resources.push(identity);
        authoring = createCoreWorkflowAuthoringDatabase(
          config,
          'validate_activation',
        );
        resources.push(authoring);
        await identity.createUser({
          id: actorId,
          email: `${actorId}@example.test`,
          displayName: 'Owned SQL guard fixture',
        });
        workspaceId = (
          await identity.createWorkspaceWithOwner({
            id: randomUUID(),
            name: 'F06 genuine guard',
            slug: `guard-${actorId}`,
            ownerUserId: actorId,
            idempotencyKey: randomUUID(),
          })
        ).id;
        const release = profile.compatibilityReleaseDescription;
        await ownerQuery(
          `insert into app.node_compatibility_releases(epoch,schema_version,fingerprint,catalog_json,prepared_by_kind,prepared_by,reason)
        values($1,1,$2,$3::jsonb,'deployment','owned-test','Disposable registered cohort fixture') on conflict(epoch) do nothing`,
          [release.epoch, release.fingerprint, release.catalogJson],
        );
        await ownerQuery(
          'update app.node_compatibility_current set epoch=$1,fingerprint=$2 where singleton',
          [release.epoch, release.fingerprint],
        );
        await ownerQuery(
          'update app.workflow_portability_rollout set import_enabled=true where singleton',
        );
        await ownerQuery(
          'update app.curated_template_rollout set import_enabled=true where singleton',
        );
        const connectionDb = createApiConnectionDatabase(config);
        resources.push(connectionDb);
        for (const [providerKey, authType] of [
          ['http', 'http_headers'],
          ['slack', 'slack_bot_token'],
        ] as const) {
          const id = randomUUID();
          connections[providerKey] = id;
          await connectionDb.createConnection({
            workspaceId,
            actorId,
            connectionId: id,
            secretVersionId: randomUUID(),
            providerKey,
            authType,
            name: 'Synthetic never-resolved guard binding',
            idempotencyKey: randomUUID(),
            requestHash: createHash('sha256').update(id).digest('hex'),
            sealed: {
              schemaVersion: 1,
              kmsKeyReference: 'f06-synthetic-never-resolved',
              encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
              ciphertext: Buffer.from('synthetic-only').toString('base64url'),
              nonce: Buffer.alloc(12, 2).toString('base64url'),
              tag: Buffer.alloc(16, 3).toString('base64url'),
            },
          });
        }
      } catch (error) {
        await cleanup();
        throw error;
      }
    }, 30_000);
    afterAll(cleanup, 20_000);

    it.each(corpus)(
      'owner SQL grammar golden corpus: $name',
      async ({ value, accepted }) => {
        if (typeof value === 'string' && value.includes('\0')) {
          expect(accepted).toBe(false);
          // PostgreSQL text cannot represent NUL: transport rejection is a separate
          // witness, never falsely labeled SQL-validator evaluation.
          await expect(
            ownerQuery('select app.curated_https_endpoint_valid($1::text)', [
              value,
            ]),
          ).rejects.toMatchObject({ code: '22021' });
          return;
        }
        const result = await ownerQuery(
          'select app.curated_https_endpoint_valid($1::text) accepted',
          [
            typeof value === 'string' || value === null
              ? value
              : JSON.stringify(value),
          ],
        );
        expect(result.rows[0]?.accepted).toBe(accepted);
      },
    );
    it.each(corpus)(
      'API-role raw creator golden corpus: $name',
      async ({ value, accepted }) => {
        const input = command(2, value);
        if (accepted) await rawAttempt(input);
        else
          await expect(rawAttempt(input)).rejects.toMatchObject({
            code:
              typeof value === 'string' && value.includes('\0')
                ? '22P05'
                : '42501',
          });
      },
    );
    it('API and worker inventory return only exact digest match; worker row and lock privileges stay forbidden', async () => {
      const digest =
        'b2c003431f093031cdaebb97b78f8a9ddae81f8ce5fa14efd4035b639a3e9f75';
      for (const pool of [api, worker])
        for (const value of [digest, null, 'malformed', '0'.repeat(64)]) {
          const result = await pool.query<{ matches: boolean }>(
            'select app.curated_template_inventory_matches($1) matches',
            [value],
          );
          expect(result.rows[0]?.matches).toBe(value === digest);
        }
      for (const sql of [
        'select * from app.curated_template_descriptors',
        'update app.curated_template_descriptors set selection_enabled=false',
        "select app.lock_curated_template_descriptor('webhook-validation-routing',1)",
      ])
        await expect(worker.query(sql)).rejects.toMatchObject({
          code: '42501',
        });
      try {
        await ownerQuery(
          'update app.curated_template_descriptors set selection_enabled=false',
        );
        expect(
          (
            await worker.query<{ matches: boolean }>(
              'select app.curated_template_inventory_matches($1) matches',
              [digest],
            )
          ).rows[0]?.matches,
        ).toBe(true);
      } finally {
        await ownerQuery(
          'update app.curated_template_descriptors set selection_enabled=true',
        );
      }
    });
    it('current compatible API and worker readiness passes without enabling or running providers', async () => {
      for (const pool of [api, worker])
        expect(
          (
            await checkDatabaseReadiness(pool, {
              ownerRole: 'pertexo_owner',
              expectedCompatibilityRelease:
                profile.compatibilityReleaseDescription,
            })
          ).migrationHead,
        ).toBe('0141_native_attempt_lock_order.sql');
    });
    it('readiness rejects confined worker descriptor privilege drift and recovers after owner restoration', async () => {
      try {
        await ownerQuery(
          'grant select on app.curated_template_descriptors to pertexo_worker',
        );
        for (const pool of [api, worker])
          await expect(checkDatabaseReadiness(pool)).rejects.toThrow();
      } finally {
        await ownerQuery(
          'revoke select on app.curated_template_descriptors from pertexo_worker',
        );
      }
      for (const pool of [api, worker]) await checkDatabaseReadiness(pool);
    });
    it('readiness rejects exact helper-body drift on both roles and recovers after restoration', async () => {
      const definition = (
        await ownerQuery(
          "select pg_get_functiondef('app.curated_https_endpoint_valid(text)'::regprocedure) definition",
        )
      ).rows[0]?.definition;
      if (typeof definition !== 'string')
        throw new Error('Guard definition unavailable');
      const end = definition.lastIndexOf('$function$');
      if (end < 0) throw new Error('Unexpected PostgreSQL function quoting');
      try {
        await ownerQuery(
          `${definition.slice(0, end)}\n-- owned fixture body pin drift\n${definition.slice(end)}`,
        );
        for (const pool of [api, worker])
          await expect(checkDatabaseReadiness(pool)).rejects.toThrow(
            'Workflow authoring schema is incompatible',
          );
      } finally {
        await ownerQuery(definition);
      }
      for (const pool of [api, worker]) await checkDatabaseReadiness(pool);
    });
    it('readiness and boolean inventory reject confined descriptor-content drift on both roles', async () => {
      const template = CURATED_WORKFLOW_TEMPLATES[2];
      if (template === undefined)
        throw new Error('Reviewed HTTP descriptor unavailable');
      const update = (targets: unknown) =>
        ownerQuery(`alter table app.curated_template_descriptors disable trigger curated_template_descriptor_immutable;
        update app.curated_template_descriptors set setup_targets='${JSON.stringify(targets).replaceAll("'", "''")}'::jsonb where template_id='controlled-http-notification';
        alter table app.curated_template_descriptors enable trigger curated_template_descriptor_immutable;`);
      try {
        // Owner-only fault injection in this disposable DB; trigger re-enabled in
        // the same transaction. Never an authorized descriptor editing pathway.
        await update([]);
        for (const pool of [api, worker]) {
          expect(
            (
              await pool.query<{ matches: boolean }>(
                'select app.curated_template_inventory_matches($1) matches',
                [
                  'b2c003431f093031cdaebb97b78f8a9ddae81f8ce5fa14efd4035b639a3e9f75',
                ],
              )
            ).rows[0]?.matches,
          ).toBe(false);
          await expect(checkDatabaseReadiness(pool)).rejects.toThrow(
            'Workflow authoring schema is incompatible',
          );
        }
      } finally {
        await update(template.setupTargets);
      }
      for (const pool of [api, worker]) await checkDatabaseReadiness(pool);
    });
    it('records authoritative PostgreSQL helper body and inventory witnesses', async () => {
      const result =
        await ownerQuery(`select oid::regprocedure::text signature,md5(prosrc) body_md5 from pg_proc where oid=any(array[
        'app.guard_curated_template_descriptor()'::regprocedure,'app.lock_curated_template_descriptor(text,integer)'::regprocedure,
        'app.curated_template_inventory_matches(text)'::regprocedure,'app.curated_https_endpoint_valid(text)'::regprocedure,
        'app.verify_curated_template_origin(jsonb,jsonb,text)'::regprocedure,'app.create_workflow_import_draft(uuid,uuid,uuid,jsonb,character,character,text)'::regprocedure,
        'app.create_workflow_duplicate_draft(uuid,uuid,uuid,uuid,character varying,integer,jsonb,character,character,text,uuid)'::regprocedure]) order by signature`);
      expect(result.rows).toHaveLength(7);
      console.info(
        'Owned F06 PostgreSQL source witnesses',
        JSON.stringify(result.rows),
      );
    });
    it('records exact validated descriptor and origin CHECK inventories', async () => {
      const result =
        await ownerQuery(`select conrelid::regclass::text relation,conname name,pg_get_constraintdef(oid) definition,convalidated validated
        from pg_constraint where conrelid=any(array['app.curated_template_descriptors'::regclass,'app.workflow_template_origins'::regclass]) and contype='c' order by relation,name`);
      expect(result.rows).toHaveLength(8);
      expect(result.rows.every((row) => row.validated === true)).toBe(true);
      console.info(
        'Owned F06 PostgreSQL CHECK witnesses',
        JSON.stringify(result.rows),
      );
    });
    it('API and worker readiness reject every missing CHECK in rollback-only owner transactions', async () => {
      const constraints = (
        await ownerQuery(`select conrelid::regclass::text relation,conname name from pg_constraint
        where conrelid=any(array['app.curated_template_descriptors'::regclass,'app.workflow_template_origins'::regclass]) and contype='c' order by relation,name`)
      ).rows;
      expect(constraints).toHaveLength(8);
      const inspector = new Pool({
        connectionString: fixture.inspectorUrl,
        max: 1,
        connectionTimeoutMillis: 3000,
      });
      try {
        for (const constraint of constraints) {
          if (
            typeof constraint.relation !== 'string' ||
            typeof constraint.name !== 'string'
          )
            throw new Error('Invalid constraint metadata');
          const client = await inspector.connect();
          // Readiness checks out a connection for metadata and the role-owned
          // inventory probe. Reuse this real transaction for both APIs; this
          // fixture alone owns rollback and release of its already-held lease.
          const transactionPool = new Proxy(inspector, {
            get(pool, key, receiver) {
              if (key === 'query') return client.query.bind(client);
              if (key === 'connect')
                return () =>
                  Promise.resolve({
                    query: client.query.bind(client),
                    release: () => undefined,
                  });
              const value: unknown = Reflect.get(pool, key, receiver);
              return value;
            },
          });
          try {
            await client.query('begin');
            await client.query("set local statement_timeout='5s'");
            await client.query('set local role pertexo_owner');
            const relation = constraint.relation
              .split('.')
              .map((part) => `"${part.replaceAll('"', '""')}"`)
              .join('.');
            const name = `"${constraint.name.replaceAll('"', '""')}"`;
            await client.query(
              `alter table ${relation} drop constraint ${name}`,
            );
            for (const role of ['pertexo_api', 'pertexo_worker']) {
              await client.query(`set local role ${role}`);
              await expect(
                checkDatabaseReadiness(transactionPool),
              ).rejects.toThrow('Workflow authoring schema is incompatible');
            }
            if (constraint.name === 'workflow_template_origins_origin_check') {
              await client.query('set local role pertexo_owner');
              await client.query(
                `alter table ${relation} add constraint ${name} check (true)`,
              );
              for (const role of ['pertexo_api', 'pertexo_worker']) {
                await client.query(`set local role ${role}`);
                await expect(
                  checkDatabaseReadiness(transactionPool),
                ).rejects.toThrow('Workflow authoring schema is incompatible');
              }
            }
          } finally {
            try {
              await client.query('rollback');
            } finally {
              client.release();
            }
          }
          for (const pool of [api, worker]) await checkDatabaseReadiness(pool);
        }
      } finally {
        await inspector.end();
      }
    });
    it.each([0, 1, 2])(
      'registered authoring commits genuine origin for asset %s',
      async (index) => {
        const input = command(index);
        const preview = await authoring.previewWorkflowImport({
          workspaceId,
          actorId,
          manifest: input.manifest,
          bindings: input.bindings,
          templateOrigin: input.templateOrigin,
        });
        expect(preview.issues).toEqual([]);
        const created = await authoring.importWorkflow(input);
        const projection = await authoring.getWorkflowWithTemplateOrigin(
          workspaceId,
          created.workflowId,
          actorId,
        );
        expect(projection?.templateOrigin).toEqual({
          ...input.templateOrigin,
          creationCommandDigest: createHash('sha256')
            .update(canonicalWorkflowPortableJson(publicCommand(input)))
            .digest('hex'),
          derivation: 'direct',
        });
        expect(
          await authoring.getWorkflow(workspaceId, created.workflowId, actorId),
        ).not.toHaveProperty('templateOrigin');
      },
    );
    it('retained replay precedes writer and descriptor retirement but still requires current authority', async () => {
      const input = command(0),
        original = await authoring.importWorkflow(input);
      try {
        await ownerQuery(
          'update app.curated_template_rollout set import_enabled=false where singleton',
        );
        await ownerQuery(
          'update app.curated_template_descriptors set selection_enabled=false where template_id=$1',
          [input.templateOrigin.templateId],
        );
        expect(await authoring.importWorkflow(input)).toEqual(original);
        await expect(
          authoring.importWorkflow({ ...input, idempotencyKey: randomUUID() }),
        ).rejects.toThrow();
        expect(
          (
            await ownerQuery(
              "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
              [workspaceId, actorId],
            )
          ).rowCount,
        ).toBe(1);
        await expect(authoring.importWorkflow(input)).rejects.toBeInstanceOf(
          WorkflowNotFoundError,
        );
      } finally {
        await ownerQuery(
          "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
          [workspaceId, actorId],
        );
        await ownerQuery(
          'update app.curated_template_descriptors set selection_enabled=true where template_id=$1',
          [input.templateOrigin.templateId],
        );
        await ownerQuery(
          'update app.curated_template_rollout set import_enabled=true where singleton',
        );
      }
    });
    it('ordinary duplication inherits genuine immutable origin without template writer or selected descriptor', async () => {
      const input = command(0),
        source = await authoring.importWorkflow(input);
      const original = await authoring.getWorkflowWithTemplateOrigin(
        workspaceId,
        source.workflowId,
        actorId,
      );
      const draft = await authoring.getDraft(
        workspaceId,
        source.workflowId,
        actorId,
      );
      if (draft === null) throw new Error('Committed draft missing');
      try {
        await ownerQuery(
          'update app.curated_template_rollout set import_enabled=false where singleton',
        );
        await ownerQuery(
          'update app.curated_template_descriptors set selection_enabled=false',
        );
        const duplicate = {
          workspaceId,
          actorId,
          workflowId: source.workflowId,
          name: 'Inherited genuine guard origin',
          source: { kind: 'draft' as const },
          idempotencyKey: randomUUID(),
          representationTag: workflowDraftRepresentationTag({
            workflowId: source.workflowId,
            revision: draft.revision,
            graph: draft.graphJson,
            compatibilityFingerprint: draft.compatibility.fingerprint,
          }),
        };
        const copy = await authoring.duplicateWorkflow(duplicate);
        expect(await authoring.duplicateWorkflow(duplicate)).toEqual(copy);
        expect(
          (
            await authoring.getWorkflowWithTemplateOrigin(
              workspaceId,
              copy.workflowId,
              actorId,
            )
          )?.templateOrigin,
        ).toEqual({ ...original?.templateOrigin, derivation: 'inherited' });
      } finally {
        await ownerQuery(
          'update app.curated_template_descriptors set selection_enabled=true',
        );
        await ownerQuery(
          'update app.curated_template_rollout set import_enabled=true where singleton',
        );
      }
    });
    it('genuine API-role creator holds descriptor SHARE until transaction end, serializing retirement', async () => {
      let releaseCreate: () => void = () => {
        throw new Error('Release barrier uninitialized');
      };
      const release = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      let createdResolve: (pid: number) => void = () => {
        throw new Error('Creation barrier uninitialized');
      };
      const created = new Promise<number>((resolve) => {
        createdResolve = resolve;
      });
      const input = command();
      const attempt = rawAttempt(
        input,
        undefined,
        undefined,
        undefined,
        async (client) => {
          const pid = (
            await client.query<{ pid: number }>('select pg_backend_pid() pid')
          ).rows[0]?.pid;
          if (pid === undefined) throw new Error('Creator PID missing');
          createdResolve(pid);
          await release;
        },
      );
      const retiring = await owner.connect();
      let update: Promise<unknown> | undefined;
      let barrierTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pid = await Promise.race([
          created,
          new Promise<never>(
            (_, reject) =>
              (barrierTimer = setTimeout(() => {
                reject(new Error('Creator barrier timed out'));
              }, 3000)),
          ),
        ]);
        await retiring.query('begin');
        await retiring.query('set local role pertexo_owner');
        await retiring.query("set local lock_timeout='4s'");
        const ownerPid = (
          await retiring.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        update = retiring.query(
          'update app.curated_template_descriptors set selection_enabled=false where template_id=$1',
          [input.templateOrigin.templateId],
        );
        const deadline = Date.now() + 2000;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked =
            (
              await owner.query<{ blocked: boolean }>(
                'select $1::integer=any(pg_blocking_pids($2)) blocked',
                [pid, ownerPid],
              )
            ).rows[0]?.blocked === true;
          if (blocked) break;
          await owner.query('select pg_sleep(0.01)');
        }
        expect(blocked).toBe(true);
        releaseCreate();
        await attempt;
        await update;
        await retiring.query('rollback');
      } finally {
        if (barrierTimer !== undefined) clearTimeout(barrierTimer);
        releaseCreate();
        try {
          await attempt;
        } finally {
          try {
            await update?.catch(() => undefined);
          } finally {
            try {
              await retiring.query('rollback');
            } finally {
              retiring.release();
            }
          }
        }
      }
    });
    it('genuine origin and retained receipt obey legal hold, expiry and bounded workspace purge', async () => {
      const scoped = (
        await identity.createWorkspaceWithOwner({
          id: randomUUID(),
          name: 'Owned origin hold purge',
          slug: `guard-purge-${randomUUID()}`,
          ownerUserId: actorId,
          idempotencyKey: randomUUID(),
        })
      ).id;
      const input = { ...command(0), workspaceId: scoped },
        accepted = await authoring.importWorkflow(input),
        hold = randomUUID();
      await ownerQuery(
        "select app.project_workspace_legal_hold($1,1,$2,'legal_hold_placed',$3,$4,$5,'owned-f06-guard','fixture-case','Preserve genuine origin receipt',clock_timestamp())",
        [scoped, randomUUID(), hold, '0'.repeat(64), 'b'.repeat(64)],
        scoped,
      );
      expect(
        (
          await ownerQuery(
            "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.import'",
            [scoped],
            scoped,
          )
        ).rowCount,
      ).toBe(1);
      await ownerQuery(
        'select * from app.reap_transient_data(1000)',
        [],
        scoped,
      );
      expect(await authoring.importWorkflow(input)).toEqual(accepted);
      expect(
        (
          await authoring.getWorkflowWithTemplateOrigin(
            scoped,
            accepted.workflowId,
            actorId,
          )
        )?.templateOrigin?.derivation,
      ).toBe('direct');
      await ownerQuery(
        "select app.project_workspace_legal_hold($1,2,$2,'legal_hold_released',$3,$4,$5,'owned-f06-guard','fixture-case','Release genuine origin receipt',clock_timestamp())",
        [scoped, randomUUID(), hold, 'b'.repeat(64), 'c'.repeat(64)],
        scoped,
      );
      await ownerQuery(
        'select * from app.reap_transient_data(1000)',
        [],
        scoped,
      );
      expect(
        (
          await ownerQuery(
            "select id from app.idempotency_records where workspace_id=$1 and operation='workflow.import'",
            [scoped],
            scoped,
          )
        ).rows,
      ).toEqual([]);
      // Receipt expiry does not erase historical origin attached to the workflow.
      expect(
        (
          await authoring.getWorkflowWithTemplateOrigin(
            scoped,
            accepted.workflowId,
            actorId,
          )
        )?.templateOrigin?.derivation,
      ).toBe('direct');
      await ownerQuery(
        "select app.project_workspace_deletion($1,3,$2,'deletion_requested',$1,$3,$4,$5,null,'Owned origin erasure',clock_timestamp()-interval '31 days')",
        [scoped, randomUUID(), 'c'.repeat(64), 'd'.repeat(64), actorId],
        scoped,
      );
      const job = (
        await ownerQuery(
          "select * from app.prepare_workspace_purge_job($1,3,$2,'owned-f06-guard',interval '1 minute')",
          [scoped, 'd'.repeat(64)],
          scoped,
        )
      ).rows[0];
      if (job === undefined) throw new Error('Expected bounded purge job');
      await ownerQuery(
        'select app.project_workspace_purge_started($1,$2,$3,4,$4,$5)',
        [
          job.job_id,
          job.lease_token,
          job.lease_fence,
          'd'.repeat(64),
          'e'.repeat(64),
        ],
        scoped,
      );
      const object = (
        await ownerQuery(
          "select * from app.claim_workspace_purge_step($1,4,$2,'owned-f06-guard',interval '1 minute')",
          [job.job_id, 'e'.repeat(64)],
          scoped,
        )
      ).rows[0];
      expect(object?.step_name).toBe('object_versions');
      await ownerQuery(
        'select app.checkpoint_workspace_object_versions_page($1,$2,$3,0,true,4,$4)',
        [job.job_id, object?.lease_token, object?.lease_fence, 'e'.repeat(64)],
        scoped,
      );
      let complete = false;
      for (let page = 0; page < 100 && !complete; page++) {
        const claim = (
          await ownerQuery(
            "select * from app.claim_workspace_purge_step($1,4,$2,'owned-f06-guard',interval '1 minute')",
            [job.job_id, 'e'.repeat(64)],
            scoped,
          )
        ).rows[0];
        expect(claim?.step_name).toBe('tenant_rows');
        complete =
          (
            await ownerQuery(
              'select * from app.execute_workspace_tenant_rows_page($1,$2,$3,500,4,$4)',
              [
                job.job_id,
                claim?.lease_token,
                claim?.lease_fence,
                'e'.repeat(64),
              ],
              scoped,
            )
          ).rows[0]?.completed === true;
      }
      expect(complete).toBe(true);
      expect(
        (
          await ownerQuery(
            'select workflow_id from app.workflow_template_origins where workspace_id=$1',
            [scoped],
            scoped,
          )
        ).rows,
      ).toEqual([]);
      await expect(authoring.importWorkflow(input)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
    });
    it('active tenant legal hold blocks destructive purge and retains genuine origin', async () => {
      const scoped = (
        await identity.createWorkspaceWithOwner({
          id: randomUUID(),
          name: 'Held genuine origin',
          slug: `guard-held-${randomUUID()}`,
          ownerUserId: actorId,
          idempotencyKey: randomUUID(),
        })
      ).id;
      const accepted = await authoring.importWorkflow({
        ...command(0),
        workspaceId: scoped,
      });
      await ownerQuery(
        "select app.project_workspace_legal_hold($1,1,$2,'legal_hold_placed',$3,$4,$5,'owned-f06-guard','held-case','Retain genuine origin',clock_timestamp())",
        [scoped, randomUUID(), randomUUID(), '0'.repeat(64), 'b'.repeat(64)],
        scoped,
      );
      await ownerQuery(
        "select app.project_workspace_deletion($1,2,$2,'deletion_requested',$1,$3,$4,$5,null,'Held erasure fixture',clock_timestamp()-interval '31 days')",
        [scoped, randomUUID(), 'b'.repeat(64), 'c'.repeat(64), actorId],
        scoped,
      );
      const job = (
        await ownerQuery(
          "select * from app.prepare_workspace_purge_job($1,2,$2,'owned-f06-guard',interval '1 minute')",
          [scoped, 'c'.repeat(64)],
          scoped,
        )
      ).rows[0];
      if (job === undefined) throw new Error('Held job missing');
      await ownerQuery(
        'select app.project_workspace_purge_started($1,$2,$3,3,$4,$5)',
        [
          job.job_id,
          job.lease_token,
          job.lease_fence,
          'c'.repeat(64),
          'd'.repeat(64),
        ],
        scoped,
      );
      await expect(
        ownerQuery(
          "select * from app.claim_workspace_purge_step($1,3,$2,'owned-f06-guard',interval '1 minute')",
          [job.job_id, 'd'.repeat(64)],
          scoped,
        ),
      ).rejects.toMatchObject({
        code: '55000',
        message: 'active workspace legal hold blocks destructive purge step',
      });
      expect(
        (
          await ownerQuery(
            'select workflow_id from app.workflow_template_origins where workspace_id=$1',
            [scoped],
            scoped,
          )
        ).rows,
      ).toEqual([{ workflow_id: accepted.workflowId }]);
    });
    it.each(['connection', 'catalog'] as const)(
      'owner %s change winning before new import rejects without partial origin',
      async (kind) => {
        const input = command();
        if (kind === 'connection') {
          const db = createApiConnectionDatabase(
            parseDatabaseConfig({ connectionString: fixture.apiUrl, max: 1 }),
          );
          resources.push(db);
          const id = randomUUID();
          await db.createConnection({
            workspaceId,
            actorId,
            connectionId: id,
            secretVersionId: randomUUID(),
            providerKey: 'http',
            authType: 'http_headers',
            name: 'Synthetic revocation witness',
            idempotencyKey: randomUUID(),
            requestHash: createHash('sha256').update(id).digest('hex'),
            sealed: {
              schemaVersion: 1,
              kmsKeyReference: 'f06-synthetic-never-resolved',
              encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
              ciphertext: Buffer.from('synthetic-only').toString('base64url'),
              nonce: Buffer.alloc(12, 2).toString('base64url'),
              tag: Buffer.alloc(16, 3).toString('base64url'),
            },
          });
          input.bindings = input.bindings.map((binding) =>
            binding.nodeId === 'controlled-http'
              ? { ...binding, connectionId: id }
              : binding,
          );
          await db.revokeConnection({ workspaceId, actorId, connectionId: id });
        }
        const before = await facts();
        const prior = (
          await ownerQuery(
            'select epoch,fingerprint from app.node_compatibility_current where singleton',
          )
        ).rows[0];
        try {
          if (kind === 'catalog')
            await ownerQuery(
              'update app.node_compatibility_current set epoch=1,fingerprint=(select fingerprint from app.node_compatibility_releases where epoch=1) where singleton',
            );
          await expect(authoring.importWorkflow(input)).rejects.toThrow();
          expect(await facts()).toEqual(before);
        } finally {
          if (kind === 'catalog')
            await ownerQuery(
              'update app.node_compatibility_current set epoch=$1,fingerprint=$2 where singleton',
              [prior?.epoch, prior?.fingerprint],
            );
        }
      },
    );
    it.each([
      'digest',
      'template',
      'version',
      'graph',
      'claim',
      'command',
    ] as const)(
      'forged %s rejected and rolled back atomically',
      async (kind) => {
        const input = command();
        if (kind === 'digest')
          input.templateOrigin.baseManifestDigest = '0'.repeat(64);
        if (kind === 'template')
          input.templateOrigin.templateId = 'unknown-template';
        if (kind === 'version') input.templateOrigin.templateVersion = 2;
        if (kind === 'graph')
          input.manifest = workflowPortableManifestSchema.parse({
            ...input.manifest,
            graph: {
              ...input.manifest.graph,
              settings: {
                ...input.manifest.graph.settings,
                maxRunDurationMs: 12345,
              },
            },
          });
        await expect(
          rawAttempt(
            input,
            undefined,
            kind === 'command' ? '{}' : undefined,
            kind === 'claim' ? 'a'.repeat(64) : undefined,
          ),
        ).rejects.toMatchObject({ code: '42501' });
      },
    );
    it.each([
      'extra-origin-field',
      'persisted-origin-fields',
      'null-origin',
      'array-origin',
      'fractional-version',
      'string-version',
      'wrong-schema',
      'missing-digest',
      'extra-command-field',
    ] as const)(
      'strict raw envelope rejects %s independently of API parsing',
      async (kind) => {
        const input = command();
        let origin: unknown = input.templateOrigin;
        switch (kind) {
          case 'extra-origin-field':
            origin = {
              ...input.templateOrigin,
              setup: { url: 'https://example.test/' },
            };
            break;
          case 'persisted-origin-fields':
            origin = {
              ...input.templateOrigin,
              creationCommandDigest: 'a'.repeat(64),
              derivation: 'inherited',
            };
            break;
          case 'null-origin':
            origin = null;
            break;
          case 'array-origin':
            origin = [];
            break;
          case 'fractional-version':
            origin = { ...input.templateOrigin, templateVersion: 1.5 };
            break;
          case 'string-version':
            origin = { ...input.templateOrigin, templateVersion: '1' };
            break;
          case 'wrong-schema':
            origin = { ...input.templateOrigin, schemaVersion: 2 };
            break;
          case 'missing-digest':
            origin = {
              schemaVersion: 1,
              templateId: input.templateOrigin.templateId,
              templateVersion: 1,
            };
            break;
          case 'extra-command-field':
            break;
        }
        const text = canonicalWorkflowPortableJson({
          ...publicCommand(input),
          templateOrigin: origin,
          ...(kind === 'extra-command-field' ? { verifiedTemplate: true } : {}),
        });
        await expect(rawAttempt(input, undefined, text)).rejects.toMatchObject({
          code: '42501',
        });
      },
    );
    it('raw creator rejects materialized graph forgery despite authentic command, receipt and bindings', async () => {
      const input = command();
      await expect(
        rawAttempt(input, {
          ...input.manifest.graph,
          settings: {
            ...input.manifest.graph.settings,
            maxRunDurationMs: 12345,
          },
        }),
      ).rejects.toMatchObject({ code: '42501' });
    });
  },
);

async function cleanup() {
  const errors: unknown[] = [];
  for (const resource of resources.splice(0).reverse())
    try {
      await resource.close();
    } catch (error) {
      errors.push(error);
    }
  try {
    await fixture.drop();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      'Owned genuine origin fixture cleanup failed',
    );
}
