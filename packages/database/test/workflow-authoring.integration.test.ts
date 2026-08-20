import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createIdentityWorkspaceDatabase } from '../src/identity-workspace.js';
import { migrateDatabase } from '../src/migrations.js';
import { checkDatabaseReadiness } from '../src/readiness.js';
import {
  createWorkflowAuthoringDatabase,
  WorkflowCreateIdempotencyConflictError,
  WorkflowPublishIdempotencyConflictError,
  WorkflowRevisionConflictError,
} from '../src/workflow-authoring.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

const identity = createIdentityWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);
const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
const apiPool = new Pool({ connectionString: apiUrl, max: 1 });
const workerPool = new Pool({ connectionString: workerUrl, max: 1 });
const dispatcherPool = new Pool({ connectionString: dispatcherUrl, max: 1 });
const actorId = randomUUID();
const otherActorId = randomUUID();
let workspaceId = '';
let workflowId = '';
let otherWorkspaceId = '';
let otherWorkflowId = '';
let otherVersionId = '';
const emptyGraph = {
  edges: [],
  nodes: [],
  schemaVersion: 1,
  settings: {},
};
const draftNode = (id: string, config: Record<string, unknown> = {}) => ({
  id,
  definition: { key: 'test.placeholder', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config,
  inputMappings: {},
  connectionRefs: {},
});
const testDefinitionCatalog = Object.freeze({
  schemaVersion: 1 as const,
  definitions: Object.freeze([
    Object.freeze({ key: 'test.placeholder', version: 1 }),
  ]),
});
const authoring = createWorkflowAuthoringDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function yieldToPostgres(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

async function executeAsOwner(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(statement, [...parameters]);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function queryAsOwner<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
  scopedWorkspaceId?: string,
): Promise<readonly T[]> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    if (scopedWorkspaceId !== undefined) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        scopedWorkspaceId,
      ]);
    }
    const result = await client.query<T>(statement, [...parameters]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await migrateDatabase(migrationConfig);
  await identity.createUser({
    id: actorId,
    email: `workflow-${actorId}@example.test`,
    displayName: 'Workflow Author',
  });
  const workspace = await identity.createWorkspaceWithOwner({
    id: randomUUID(),
    name: 'Workflow Authoring Proof',
    slug: `workflow-${actorId}`,
    ownerUserId: actorId,
    idempotencyKey: `workflow-${actorId}`,
  });
  workspaceId = workspace.id;
  await identity.createUser({
    id: otherActorId,
    email: `workflow-${otherActorId}@example.test`,
    displayName: 'Other Workflow Author',
  });
  const otherWorkspace = await identity.createWorkspaceWithOwner({
    id: randomUUID(),
    name: 'Other Workflow Workspace',
    slug: `workflow-${otherActorId}`,
    ownerUserId: otherActorId,
    idempotencyKey: `workflow-${otherActorId}`,
  });
  otherWorkspaceId = otherWorkspace.id;
  const otherWorkflow = await authoring.createWorkflow({
    actorId: otherActorId,
    emptyGraph,
    idempotencyKey: 'create-other-workflow',
    name: 'Other workflow',
    workspaceId: otherWorkspaceId,
  });
  otherWorkflowId = otherWorkflow.workflowId;
  const otherPublication = await authoring.publishWorkflow({
    actorId: otherActorId,
    expectedRevision: 1,
    idempotencyKey: 'publish-other-workflow',
    requestHash: '0'.repeat(64),
    workflowId: otherWorkflowId,
    workspaceId: otherWorkspaceId,
  });
  otherVersionId = otherPublication.version.id;
});

afterAll(async () => {
  await authoring.close();
  await identity.close();
  await ownerPool.end();
  await apiPool.end();
  await workerPool.end();
  await dispatcherPool.end();
});

describe('workflow authoring persistence', () => {
  it('passes role-aware readiness for API, worker, and dispatcher', async () => {
    const apiReadiness = await checkDatabaseReadiness(apiPool);
    const workerReadiness = await checkDatabaseReadiness(workerPool);
    const dispatcherReadiness = await checkDatabaseReadiness(dispatcherPool);
    expect(apiReadiness.role).toBe('pertexo_api');
    expect(workerReadiness.role).toBe('pertexo_worker');
    expect(dispatcherReadiness.role).toBe('pertexo_dispatcher');
    await expect(
      checkDatabaseReadiness(apiPool, {
        ownerRole: 'pertexo_owner',
        supportedGraphSchemaVersions: [],
      }),
    ).rejects.toThrow('Workflow graph schema support is incompatible');
    await expect(
      checkDatabaseReadiness(apiPool, {
        ownerRole: 'pertexo_owner',
        supportedChecksumAlgorithms: [],
      }),
    ).rejects.toThrow('Workflow checksum support is incompatible');
  });

  it('fails readiness on policy, grant, function, and dispatch-index drift', async () => {
    const workspacePolicy = `
      alter policy workflows_workspace_scope on app.workflows
      to pertexo_owner, pertexo_api
      using (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
      with check (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))`;

    await executeAsOwner(`
      alter policy workflows_workspace_scope on app.workflows
      using (true) with check (true)`);
    try {
      await expect(checkDatabaseReadiness(apiPool)).rejects.toThrow(
        'Workflow authoring row-level security is incompatible',
      );
    } finally {
      await executeAsOwner(workspacePolicy);
    }

    await executeAsOwner(
      'grant select on app.workflow_versions to pertexo_worker',
    );
    try {
      await expect(checkDatabaseReadiness(workerPool)).rejects.toThrow(
        'Workflow authoring runtime grants are incompatible',
      );
    } finally {
      await executeAsOwner(
        'revoke select on app.workflow_versions from pertexo_worker',
      );
    }

    const creatorSignature = `app.create_workflow_with_draft(
      uuid, uuid, varchar, uuid, integer, jsonb, char, char, varchar, varchar
    )`;
    await executeAsOwner(
      `alter function ${creatorSignature} set search_path = pg_catalog, public`,
    );
    try {
      await expect(checkDatabaseReadiness(apiPool)).rejects.toThrow(
        'Workflow authoring schema is incompatible',
      );
    } finally {
      await executeAsOwner(
        `alter function ${creatorSignature} set search_path = pg_catalog, pg_temp`,
      );
    }

    await executeAsOwner('drop index app.outbox_events_dispatch_job_due_idx');
    try {
      await expect(checkDatabaseReadiness(apiPool)).rejects.toThrow(
        'Workflow authoring schema is incompatible',
      );
    } finally {
      await executeAsOwner(`
        create index outbox_events_dispatch_job_due_idx
        on app.outbox_events (job_name, available_at, id)
        where published_at is null and failed_at is null`);
    }
  });

  it('atomically creates a workflow with exactly one revision-1 draft', async () => {
    const createInput = {
      actorId,
      emptyGraph,
      idempotencyKey: 'create-first-workflow',
      name: 'First workflow',
      workspaceId,
    } as const;
    const created = await authoring.createWorkflow(createInput);
    workflowId = created.workflowId;
    await expect(
      authoring.getDraft(workspaceId, workflowId, actorId),
    ).resolves.toMatchObject({ revision: 1, schemaVersion: 1, workspaceId });
    await expect(authoring.createWorkflow(createInput)).resolves.toMatchObject({
      workflowId,
    });
    await expect(
      authoring.createWorkflow({ ...createInput, name: 'Changed request' }),
    ).rejects.toBeInstanceOf(WorkflowCreateIdempotencyConflictError);
    await expect(
      authoring.listWorkflows({ workspaceId, actorId }),
    ).resolves.toHaveLength(1);

    const concurrentInput = {
      ...createInput,
      idempotencyKey: 'create-concurrent-workflow',
      name: 'Concurrent workflow',
    };
    const concurrent = await Promise.all([
      authoring.createWorkflow(concurrentInput),
      authoring.createWorkflow(concurrentInput),
    ]);
    expect(concurrent[0].workflowId).toBe(concurrent[1].workflowId);
    await expect(
      authoring.listWorkflows({ workspaceId, actorId, limit: 2 }),
    ).resolves.toHaveLength(2);
    const firstPage = await authoring.listWorkflows({
      workspaceId,
      actorId,
      limit: 1,
    });
    const firstWorkflow = firstPage[0];
    expect(firstWorkflow).toBeDefined();
    if (firstWorkflow === undefined) throw new Error('Missing first page row');
    const rename = await apiPool.connect();
    try {
      await rename.query('begin');
      await rename.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await rename.query(
        "update app.workflows set name = 'Renamed between pages' where id = $1",
        [firstWorkflow.id],
      );
      await rename.query('commit');
    } finally {
      rename.release();
    }
    const secondPage = await authoring.listWorkflows({
      workspaceId,
      actorId,
      after: { createdAt: firstWorkflow.createdAt, id: firstWorkflow.id },
      limit: 10,
    });
    expect(secondPage.map((workflow) => workflow.id)).not.toContain(
      firstWorkflow.id,
    );

    const grants = await workerPool.query<{ can_read: boolean }>(
      "select has_table_privilege(current_user, 'app.workflow_versions', 'SELECT') as can_read",
    );
    expect(grants.rows[0]?.can_read).toBe(false);

    await expect(
      authoring.getDraft(otherWorkspaceId, otherWorkflowId, actorId),
    ).rejects.toThrow('Workflow is not visible');

    const api = await apiPool.connect();
    try {
      const absent = await api.query<{ drafts: string }>(
        `select (
          (select count(*) from app.workflow_drafts) +
          (select count(*) from app.workflow_versions) +
          (select count(*) from app.audit_events) +
          (select count(*) from app.idempotency_records) +
          (select count(*) from app.outbox_events)
        )::text as drafts`,
      );
      expect(absent.rows[0]?.drafts).toBe('0');
      await api.query('begin');
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      const crossWorkspace = await api.query<{ drafts: string }>(
        `select (
          (select count(*) from app.workflow_drafts where workflow_id = $1) +
          (select count(*) from app.workflow_versions where workflow_id = $1) +
          (select count(*) from app.audit_events where target_id = $1) +
          (select count(*) from app.idempotency_records where resource_id = $1) +
          (select count(*) from app.outbox_events where aggregate_id = $1)
        )::text as drafts`,
        [otherWorkflowId],
      );
      expect(crossWorkspace.rows[0]?.drafts).toBe('0');
      await expect(
        api.query(
          `insert into app.workflow_drafts
             (workflow_id, workspace_id, revision, schema_version, graph_json, updated_by)
           values ($1, $2, 1, 1, '{}'::jsonb, $3)`,
          [randomUUID(), workspaceId, actorId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await api.query('rollback');
      await api.query('begin');
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await expect(
        api.query('delete from app.workflow_drafts where workflow_id = $1', [
          workflowId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await api.query('rollback');
    } finally {
      api.release();
    }
  });

  it('rejects absent-context and cross-tenant writes for every publication relation', async () => {
    const attempts: readonly (readonly [string, unknown[]])[] = [
      [
        `insert into app.workflow_versions
          (id, workspace_id, workflow_id, version_number, schema_version,
           graph_json, checksum, published_by)
         values ($1, $2, $3, 999, 1, '{}'::jsonb, $4, $5)`,
        [
          randomUUID(),
          otherWorkspaceId,
          otherWorkflowId,
          `wf:v1:sha256:${'1'.repeat(64)}`,
          otherActorId,
        ],
      ],
      [
        `insert into app.audit_events
          (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1, $2, $3, 'workflow.published', 'workflow', $4, '{}'::jsonb)`,
        [randomUUID(), otherWorkspaceId, otherActorId, otherWorkflowId],
      ],
      [
        `insert into app.idempotency_records
          (id, workspace_id, operation, scope, key_hash, request_hash,
           status, resource_id, result_ref)
         values ($1, $2, 'workflow.publish', $3, $4, $5,
           'in_progress', $6, '{}'::jsonb)`,
        [
          randomUUID(),
          otherWorkspaceId,
          `${otherActorId}:${otherWorkflowId}`,
          '2'.repeat(64),
          '3'.repeat(64),
          otherWorkflowId,
        ],
      ],
      [
        `insert into app.outbox_events
          (id, workspace_id, job_name, schema_version, aggregate_type,
           aggregate_id, payload, payload_checksum)
         values ($1, $2, 'reconcile-workflow-triggers', 1, 'workflow',
           $3, '{}'::jsonb, $4)`,
        [randomUUID(), otherWorkspaceId, otherWorkflowId, '4'.repeat(64)],
      ],
    ];
    for (const [statement, parameters] of attempts) {
      const client = await apiPool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.workspace_id', $1, true)", [
          workspaceId,
        ]);
        await expect(client.query(statement, parameters)).rejects.toMatchObject(
          { code: '42501' },
        );
        await client.query('rollback');
      } finally {
        client.release();
      }
    }

    const absent = await apiPool.connect();
    try {
      await expect(
        absent.query(
          `insert into app.audit_events
            (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
           values ($1, $2, $3, 'workflow.published', 'workflow', $4, '{}'::jsonb)`,
          [randomUUID(), workspaceId, actorId, workflowId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      absent.release();
    }
    expect(otherVersionId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('accepts the exact compact graph limit and rejects one byte over before insert', async () => {
    const graphEnvelope = {
      ...emptyGraph,
      nodes: [draftNode('large', { padding: '' })],
    };
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify(graphEnvelope),
      'utf8',
    );
    const exactGraph = {
      ...graphEnvelope,
      nodes: [
        draftNode('large', {
          padding: 'x'.repeat(1_048_576 - envelopeBytes),
        }),
      ],
    };
    const exactCreated = await authoring.createWorkflow({
      actorId,
      emptyGraph: exactGraph,
      idempotencyKey: 'create-exact-limit',
      name: 'Exact limit',
      workspaceId,
    });
    expect(exactCreated.workflowId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(
      authoring.createWorkflow({
        actorId,
        emptyGraph: {
          ...exactGraph,
          nodes: [
            draftNode('large', {
              padding: `${String(exactGraph.nodes[0]?.config.padding)}x`,
            }),
          ],
        },
        idempotencyKey: 'create-over-limit',
        name: 'Over limit',
        workspaceId,
      }),
    ).rejects.toThrow('graph bytes exceed the graph limit');
  });

  it('uses the workflow-model contract at every draft persistence boundary', async () => {
    await expect(
      authoring.createWorkflow({
        actorId,
        emptyGraph: {},
        idempotencyKey: 'create-invalid-graph',
        name: 'Invalid graph',
        workspaceId,
      }),
    ).rejects.toThrow();
    await expect(
      authoring.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, unknown: true },
        workflowId,
        workspaceId,
      }),
    ).rejects.toThrow();

    const corrupted = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-corrupt-read-proof',
      name: 'Corrupt read proof',
      workspaceId,
    });
    const api = await apiPool.connect();
    try {
      await api.query('begin');
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await api.query(
        "update app.workflow_drafts set graph_json = '{}'::jsonb where workflow_id = $1",
        [corrupted.workflowId],
      );
      await api.query('commit');
    } finally {
      api.release();
    }
    await expect(
      authoring.getDraft(workspaceId, corrupted.workflowId, actorId),
    ).rejects.toThrow();
  });

  it('rejects a retained version whose checksum does not match its graph', async () => {
    const corrupted = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-corrupt-version-proof',
      name: 'Corrupt version proof',
      workspaceId,
    });
    const versionId = randomUUID();
    const corruptingClient = await apiPool.connect();
    try {
      await corruptingClient.query('begin');
      await corruptingClient.query(
        "select set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      await corruptingClient.query(
        `insert into app.workflow_versions
           (id, workspace_id, workflow_id, version_number, schema_version,
            graph_json, checksum, published_by)
         values ($1, $2, $3, 1, 1, $4::jsonb, $5, $6)`,
        [
          versionId,
          workspaceId,
          corrupted.workflowId,
          JSON.stringify(emptyGraph),
          `wf:v1:sha256:${'f'.repeat(64)}`,
          actorId,
        ],
      );
      await corruptingClient.query('commit');
    } catch (error: unknown) {
      await corruptingClient.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      corruptingClient.release();
    }

    await expect(
      authoring.getVersion(
        workspaceId,
        corrupted.workflowId,
        versionId,
        actorId,
      ),
    ).rejects.toThrow('checksum does not match its graph');
    await expect(
      authoring.publishWorkflow({
        actorId,
        expectedRevision: 1,
        idempotencyKey: 'publish-corrupt-version-proof',
        requestHash: 'f'.repeat(64),
        workflowId: corrupted.workflowId,
        workspaceId,
      }),
    ).rejects.toThrow('checksum does not match its graph');

    const durableState = await queryAsOwner<{
      audits: string;
      outbox: string;
      published_version_id: string | null;
      versions: string;
    }>(
      `select workflow.published_version_id,
              (select count(*) from app.workflow_versions version
               where version.workflow_id = workflow.id)::text as versions,
              (select count(*) from app.audit_events audit
               where audit.target_id = workflow.id
                 and audit.action = 'workflow.published')::text as audits,
              (select count(*) from app.outbox_events event
               where event.aggregate_id = workflow.id
                 and event.job_name = 'reconcile-workflow-triggers')::text as outbox
       from app.workflows workflow where workflow.id = $1`,
      [corrupted.workflowId],
      workspaceId,
    );
    expect(durableState[0]).toEqual({
      audits: '0',
      outbox: '0',
      published_version_id: null,
      versions: '1',
    });
  });

  it('uses canonical executable identity rather than JSON or presentation identity', async () => {
    const catalogAuthoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      { definitionCatalog: testDefinitionCatalog },
    );
    try {
      const baseGraph = {
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('canonical', { a: 1, b: 2 }),
            label: 'First label',
            position: { x: 1, y: 2 },
          },
        ],
      };
      const created = await catalogAuthoring.createWorkflow({
        actorId,
        emptyGraph: baseGraph,
        idempotencyKey: 'create-canonical-proof',
        name: 'Canonical proof',
        workspaceId,
      });
      const first = await catalogAuthoring.publishWorkflow({
        actorId,
        expectedRevision: 1,
        idempotencyKey: 'publish-canonical-first',
        requestHash: '1'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      await expect(
        authoring.getVersion(
          workspaceId,
          created.workflowId,
          first.version.id,
          actorId,
        ),
      ).resolves.toMatchObject({
        checksum: first.version.checksum,
        graphJson: baseGraph,
      });
      await catalogAuthoring.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: {
          ...baseGraph,
          nodes: [
            {
              ...draftNode('canonical', { b: 2, a: 1 }),
              label: 'Presentation changed',
              position: { x: 500, y: 600 },
            },
          ],
        },
        workflowId: created.workflowId,
        workspaceId,
      });
      const presentationOnly = await catalogAuthoring.publishWorkflow({
        actorId,
        expectedRevision: 2,
        idempotencyKey: 'publish-canonical-presentation',
        requestHash: '2'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      expect(presentationOnly).toMatchObject({
        reused: true,
        version: { id: first.version.id, checksum: first.version.checksum },
      });

      await catalogAuthoring.saveDraft({
        actorId,
        expectedRevision: 2,
        graphJson: {
          ...baseGraph,
          nodes: [draftNode('canonical', { a: 1, b: 3 })],
        },
        workflowId: created.workflowId,
        workspaceId,
      });
      const executableChange = await catalogAuthoring.publishWorkflow({
        actorId,
        expectedRevision: 3,
        idempotencyKey: 'publish-canonical-executable',
        requestHash: '3'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      expect(executableChange.reused).toBe(false);
      expect(executableChange.version.id).not.toBe(first.version.id);
      expect(executableChange.version.checksum).not.toBe(
        first.version.checksum,
      );

      await authoring.saveDraft({
        actorId,
        expectedRevision: 3,
        graphJson: emptyGraph,
        workflowId: created.workflowId,
        workspaceId,
      });
      await expect(
        authoring.publishWorkflow({
          actorId,
          expectedRevision: 4,
          idempotencyKey: 'publish-after-unsupported-history',
          requestHash: '4'.repeat(64),
          workflowId: created.workflowId,
          workspaceId,
        }),
      ).resolves.toMatchObject({ replayed: false, reused: false });
    } finally {
      await catalogAuthoring.close();
    }
  });

  it('allows exactly one racing compare-and-swap save', async () => {
    const results = await Promise.allSettled([
      authoring.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 1_000 } },
        workflowId,
        workspaceId,
      }),
      authoring.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 2_000 } },
        workflowId,
        workspaceId,
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection?.status).toBe('rejected');
    if (rejection?.status === 'rejected') {
      expect(rejection.reason).toBeInstanceOf(WorkflowRevisionConflictError);
    }
    await expect(
      authoring.getDraft(workspaceId, workflowId, actorId),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(
      authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: 'create-first-workflow',
        name: 'First workflow',
        workspaceId,
      }),
    ).resolves.toEqual({ workflowId });
  });

  it('serializes both save-first and publish-first lock orders without graph skew', async () => {
    const saveFirstDraft = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-save-first-race',
      name: 'Save first race',
      workspaceId,
    });
    const saveLocked = deferred();
    const releaseSave = deferred();
    const saveFirstDatabase = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        testHooks: {
          afterSaveCas: async () => {
            saveLocked.resolve();
            await releaseSave.promise;
          },
        },
      },
    );
    try {
      const save = saveFirstDatabase.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: {
          ...emptyGraph,
          settings: { maxRunDurationMs: 3_000 },
        },
        workflowId: saveFirstDraft.workflowId,
        workspaceId,
      });
      await saveLocked.promise;
      const publish = authoring.publishWorkflow({
        actorId,
        expectedRevision: 1,
        idempotencyKey: 'publish-save-first-race',
        requestHash: '5'.repeat(64),
        workflowId: saveFirstDraft.workflowId,
        workspaceId,
      });
      await yieldToPostgres();
      releaseSave.resolve();
      await expect(save).resolves.toMatchObject({ revision: 2 });
      await expect(publish).rejects.toMatchObject({ currentRevision: 2 });
    } finally {
      await saveFirstDatabase.close();
    }

    const publishFirstDraft = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-publish-first-race',
      name: 'Publish first race',
      workspaceId,
    });
    const publishLocked = deferred();
    const releasePublish = deferred();
    const publishFirstDatabase = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        testHooks: {
          afterPublishDraftLock: async () => {
            publishLocked.resolve();
            await releasePublish.promise;
          },
        },
      },
    );
    try {
      const publish = publishFirstDatabase.publishWorkflow({
        actorId,
        expectedRevision: 1,
        idempotencyKey: 'publish-publish-first-race',
        requestHash: '7'.repeat(64),
        workflowId: publishFirstDraft.workflowId,
        workspaceId,
      });
      await publishLocked.promise;
      const save = authoring.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: {
          ...emptyGraph,
          settings: { maxRunDurationMs: 4_000 },
        },
        workflowId: publishFirstDraft.workflowId,
        workspaceId,
      });
      await yieldToPostgres();
      releasePublish.resolve();
      await expect(publish).resolves.toMatchObject({
        version: { graphJson: emptyGraph },
      });
      await expect(save).resolves.toMatchObject({ revision: 2 });
    } finally {
      await publishFirstDatabase.close();
    }
  });

  it('rolls back every material publication step and locked-validator failure', async () => {
    const steps = [
      'version',
      'pointer',
      'outbox',
      'audit',
      'idempotency',
    ] as const;
    for (const step of steps) {
      const created = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: `create-rollback-${step}`,
        name: `Rollback ${step}`,
        workspaceId,
      });
      const faulting = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
        {
          testHooks: {
            afterPublishStep: (reached) =>
              reached === step
                ? Promise.reject(new Error(`injected-${step}`))
                : Promise.resolve(),
          },
        },
      );
      try {
        await expect(
          faulting.publishWorkflow({
            actorId,
            expectedRevision: 1,
            idempotencyKey: `publish-rollback-${step}`,
            requestHash: createHash('sha256').update(step).digest('hex'),
            workflowId: created.workflowId,
            workspaceId,
          }),
        ).rejects.toThrow(`injected-${step}`);
      } finally {
        await faulting.close();
      }
      const proof = await apiPool.connect();
      try {
        await proof.query('begin');
        await proof.query("select set_config('app.workspace_id', $1, true)", [
          workspaceId,
        ]);
        const rows = await proof.query<{
          audits: string;
          commands: string;
          outbox: string;
          pointer: string | null;
          versions: string;
        }>(
          `select
            (select count(*) from app.workflow_versions where workflow_id = $1)::text versions,
            (select count(*) from app.audit_events where target_id = $1 and action = 'workflow.published')::text audits,
            (select count(*) from app.outbox_events where aggregate_id = $1 and job_name = 'reconcile-workflow-triggers')::text outbox,
            (select count(*) from app.idempotency_records where resource_id = $1 and operation = 'workflow.publish')::text commands,
            (select published_version_id::text from app.workflows where id = $1) pointer`,
          [created.workflowId],
        );
        expect(rows.rows[0]).toEqual({
          audits: '0',
          commands: '0',
          outbox: '0',
          pointer: null,
          versions: '0',
        });
        await proof.query('rollback');
      } finally {
        proof.release();
      }
    }

    const invalid = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-validator-failure',
      name: 'Validator failure',
      workspaceId,
    });
    await authoring.saveDraft({
      actorId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, nodes: [draftNode('unknown-definition')] },
      workflowId: invalid.workflowId,
      workspaceId,
    });
    await expect(
      authoring.publishWorkflow({
        actorId,
        expectedRevision: 2,
        idempotencyKey: 'publish-validator-failure',
        requestHash: '8'.repeat(64),
        workflowId: invalid.workflowId,
        workspaceId,
      }),
    ).rejects.toThrow('workflow graph failed semantic validation');
    await expect(
      authoring.getVersion(
        workspaceId,
        invalid.workflowId,
        randomUUID(),
        actorId,
      ),
    ).resolves.toBeNull();
  });

  it('publishes atomically, replays exactly, and rejects changed key reuse', async () => {
    const draft = await authoring.getDraft(workspaceId, workflowId, actorId);
    expect(draft).not.toBeNull();
    const input = {
      actorId,
      expectedRevision: draft?.revision ?? 0,
      idempotencyKey: 'publish-proof',
      requestHash: 'a'.repeat(64),
      workflowId,
      workspaceId,
    } as const;
    await expect(
      authoring.publishWorkflow({
        ...input,
        idempotencyKey: 'publish-rollback',
        requestHash: 'e'.repeat(64),
        traceId: 'x'.repeat(129),
      }),
    ).rejects.toMatchObject({ code: '22001' });

    const publications = await Promise.all([
      authoring.publishWorkflow(input),
      authoring.publishWorkflow(input),
    ]);
    expect(publications.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const published = publications[0];
    const saved = await authoring.saveDraft({
      actorId,
      expectedRevision: input.expectedRevision,
      graphJson: draft?.graphJson ?? {},
      workflowId,
      workspaceId,
    });
    await expect(authoring.publishWorkflow(input)).resolves.toMatchObject({
      replayed: true,
      version: { id: published.version.id },
    });
    await expect(
      authoring.publishWorkflow({
        ...input,
        idempotencyKey: 'publish-stale-distinct',
        requestHash: '9'.repeat(64),
      }),
    ).rejects.toMatchObject({ currentRevision: saved.revision });
    const currentPublications = await Promise.all([
      authoring.publishWorkflow({
        ...input,
        expectedRevision: saved.revision,
        idempotencyKey: 'publish-current-distinct-a',
        requestHash: 'd'.repeat(64),
      }),
      authoring.publishWorkflow({
        ...input,
        expectedRevision: saved.revision,
        idempotencyKey: 'publish-current-distinct-b',
        requestHash: 'f'.repeat(64),
      }),
    ]);
    expect(currentPublications).toEqual([
      expect.objectContaining({ replayed: false, reused: true }),
      expect.objectContaining({ replayed: false, reused: true }),
    ]);
    await expect(
      authoring.publishWorkflow({ ...input, requestHash: 'c'.repeat(64) }),
    ).rejects.toBeInstanceOf(WorkflowPublishIdempotencyConflictError);

    const owner = await ownerPool.connect();
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await expect(
        owner.query(
          'update app.workflow_versions set version_number = 99 where id = $1',
          [published.version.id],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await owner.query('rollback');
    } finally {
      owner.release();
    }

    const api = await apiPool.connect();
    try {
      await api.query('begin');
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      const facts = await api.query<{
        audits: string;
        outbox: string;
        versions: string;
      }>(
        `select
        (select count(*) from app.audit_events where workspace_id = $1 and target_id = $2 and action = 'workflow.published')::text as audits,
        (select count(*) from app.outbox_events where workspace_id = $1 and aggregate_id = $2 and job_name = 'reconcile-workflow-triggers')::text as outbox,
        (select count(*) from app.workflow_versions where workspace_id = $1 and workflow_id = $2)::text as versions`,
        [workspaceId, workflowId],
      );
      expect(facts.rows[0]).toEqual({
        audits: '3',
        outbox: '3',
        versions: '1',
      });
      await api.query('rollback');
    } finally {
      api.release();
    }
  });
});
