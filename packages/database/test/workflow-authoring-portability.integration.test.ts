import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalWorkflowPortableJson,
  portableGraphDigest,
} from '@pertexo/workflow-model/portability-contract';
import {
  projectWorkflowPortableManifest,
  type WorkflowPortabilityCatalog,
} from '@pertexo/workflow-model/portability';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model/graph';
import {
  WorkflowPortabilityCompatibilityConflictError,
  WorkflowPortabilityReviewConflictError,
  WorkflowPortabilityUnavailableError,
  WorkflowPortabilityValidationError,
} from '../src/authoring/workflow-authoring-errors.js';
import type { ImportWorkflowInput } from '../src/authoring/workflow-authoring-contracts.js';
import type { WorkflowAuthoringDatabaseOptions } from '../src/authoring/workflow-authoring-types.js';
import {
  actorId,
  otherActorId,
  workspaceId,
  otherWorkspaceId,
  otherVersionId,
  apiUrl,
  apiPool,
  migrationUrl,
  createWorkflowAuthoringDatabase,
  parseDatabaseConfig,
  BASELINE_COMPATIBILITY_EXPECTATION,
  currentRepresentationTag,
  emptyGraph,
  draftNode,
  randomUUID,
  executeAsOwner,
  queryAsOwner,
  identity,
  authoring,
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  Pool,
  createConnectionDatabase,
  CONNECTION_AUTH_TYPE,
  createHash,
  deferred,
  waitForOperationEntry,
  waitForPostgresLock,
  withApplicationName,
  finishControlledScenario,
  finishTransactionClient,
  saveCurrentDraft,
  checkDatabaseReadiness,
} from './support/workflow-authoring.integration.support.js';

const catalog = {
  schemaVersion: 1 as const,
  releaseFingerprint: BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
  definitions: [{ key: 'test.placeholder', version: 1 }],
};
const portableCatalog: WorkflowPortabilityCatalog = {
  fingerprint: catalog.releaseFingerprint,
  definitions: [
    {
      key: 'test.placeholder',
      version: 1,
      configVersion: 1,
      slots: [],
      validateConfig: () => true,
    },
  ],
  selectionFingerprint: () => `node-select:v1:sha256:${'1'.repeat(64)}`,
};
const options: WorkflowAuthoringDatabaseOptions = {
  compatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
  definitionCatalog: catalog,
  placementDefinitionCatalog: catalog,
  portableCatalog,
};
const databases: ReturnType<typeof createWorkflowAuthoringDatabase>[] = [];
function database(extra: WorkflowAuthoringDatabaseOptions = {}, url = apiUrl) {
  const result = createWorkflowAuthoringDatabase(
    parseDatabaseConfig({ connectionString: url, max: 4 }),
    { ...options, ...extra },
  );
  databases.push(result);
  return result;
}
function command(
  extra: Partial<ImportWorkflowInput> = {},
): ImportWorkflowInput {
  return {
    workspaceId,
    actorId,
    name: 'Portable independent workflow',
    manifest: projectWorkflowPortableManifest(
      parseWorkflowGraphDraft(emptyGraph),
      portableCatalog,
    ),
    bindings: [],
    expectedCompatibilityFingerprint: catalog.releaseFingerprint,
    idempotencyKey: randomUUID(),
    ...extra,
  };
}
async function gate(enabled: boolean) {
  await executeAsOwner(
    'update app.workflow_portability_rollout set import_enabled=$1 where singleton',
    [enabled],
  );
}
async function facts() {
  return queryAsOwner(
    `select (select count(*)::int from app.workflows where workspace_id=$1) workflows,
    (select count(*)::int from app.workflow_drafts where workspace_id=$1) drafts,
    (select count(*)::int from app.idempotency_records where workspace_id=$1 and operation='workflow.import') receipts,
    (select count(*)::int from app.audit_events where workspace_id=$1 and action='workflow.imported') audits`,
    [workspaceId],
    workspaceId,
  );
}
async function firstFacts() {
  const row = (await facts())[0];
  if (row === undefined) throw new Error('Expected import fact counts');
  return row;
}
beforeAll(async () => {
  await gate(true);
});
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe('portable workflow persistence under the API role', () => {
  it('has default-off gate migration, independent readers and disabled exact completed replay', async () => {
    const db = database();
    const input = command();
    const result = await db.importWorkflow(input);
    await gate(false);
    try {
      expect(
        (await db.previewWorkflowImport(inputForPreview(input))).compatible,
      ).toBe(true);
      expect(await db.importWorkflow(input)).toEqual(result);
      const before = await facts();
      await expect(db.importWorkflow(command())).rejects.toBeInstanceOf(
        WorkflowPortabilityUnavailableError,
      );
      expect(await facts()).toEqual(before);
      const gateRows = await apiPool.query(
        'select import_enabled from app.workflow_portability_rollout',
      );
      expect(gateRows.rows).toEqual([{ import_enabled: false }]);
      await expect(
        apiPool.query(
          'update app.workflow_portability_rollout set import_enabled=true',
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await gate(true);
    }
  });

  it('creates one normal-default unpublished revision-1 draft, safe audit and identifier-only receipt atomically', async () => {
    const db = database();
    const input = command({ name: '  Trimmed destination  ' });
    const before = await firstFacts();
    const accepted = await db.importWorkflow(input);
    const draft = await db.getDraft(workspaceId, accepted.workflowId, actorId);
    expect(draft).toMatchObject({ revision: 1, graphJson: emptyGraph });
    const workflow = await db.getWorkflow(
      workspaceId,
      accepted.workflowId,
      actorId,
    );
    expect(workflow).toMatchObject({
      name: 'Trimmed destination',
      nameRevision: 1,
      lifecycleRevision: 1,
      lifecycleStatus: 'active',
      activationStatus: 'inactive',
      publishedVersionId: null,
    });
    const rows = await queryAsOwner(
      `select scope,result_ref,resource_id::text,expires_at-created_at ttl from app.idempotency_records where workspace_id=$1 and operation='workflow.import' and resource_id=$2`,
      [workspaceId, accepted.workflowId],
      workspaceId,
    );
    expect(rows[0]).toMatchObject({
      scope: actorId,
      resource_id: accepted.workflowId,
      result_ref: accepted,
    });
    expect(Object.keys(accepted)).toEqual(['workflowId']);
    expect((await facts())[0]).toEqual({
      workflows: Number(before.workflows) + 1,
      drafts: Number(before.drafts) + 1,
      receipts: Number(before.receipts) + 1,
      audits: Number(before.audits) + 1,
    });
    const audits = await queryAsOwner(
      'select metadata from app.audit_events where workspace_id=$1 and action=$2 and target_id=$3',
      [workspaceId, 'workflow.imported', accepted.workflowId],
      workspaceId,
    );
    expect(audits).toEqual([{ metadata: { revision: 1 } }]);
  });

  it('replays after restart without later catalog/binding checks and conflicts on any changed frozen command', async () => {
    const first = database();
    const input = command();
    const result = await first.importWorkflow(input);
    await first.close();
    const restarted = database({
      portableCatalog: {
        ...portableCatalog,
        fingerprint: 'unavailable-after-restart',
      },
    });
    expect(await restarted.importWorkflow(input)).toEqual(result);
    for (const changed of [
      { name: 'Changed' },
      {
        expectedCompatibilityFingerprint: `node-compat:v1:sha256:${'0'.repeat(64)}`,
      },
      {
        manifest: {
          ...input.manifest,
          graph: {
            ...input.manifest.graph,
            settings: { maxRunDurationMs: 1000 },
          },
        },
      },
    ]) {
      await expect(
        restarted.importWorkflow({ ...input, ...changed }),
      ).rejects.toBeInstanceOf(WorkflowIdempotencyConflictError);
    }
  });

  it('serializes concurrent same-key requests and accepts distinct keys independently', async () => {
    const db = database();
    const input = command();
    const before = await firstFacts();
    const accepted = await Promise.all(
      Array.from({ length: 4 }, () => db.importWorkflow(input)),
    );
    expect(new Set(accepted.map(({ workflowId }) => workflowId)).size).toBe(1);
    expect(Number((await firstFacts()).workflows)).toBe(
      Number(before.workflows) + 1,
    );
    const independent = await Promise.all([
      db.importWorkflow(command()),
      db.importWorkflow(command()),
    ]);
    expect(independent[0].workflowId).not.toBe(independent[1].workflowId);
    const raced = command();
    const settled = await Promise.allSettled([
      db.importWorkflow(raced),
      db.importWorkflow({ ...raced, name: 'Different command' }),
    ]);
    expect(
      settled.filter((entry) => entry.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = settled.find((entry) => entry.status === 'rejected');
    expect(rejected?.reason instanceof WorkflowIdempotencyConflictError).toBe(
      true,
    );
  });

  it.each([
    'claim',
    'catalog',
    'connections',
    'workflow',
    'draft',
    'audit',
    'idempotency',
  ] as const)('rolls back all import facts after %s fault', async (step) => {
    const db = database({
      testHooks: {
        afterImportStep: (observed) =>
          observed === step
            ? Promise.reject(new Error('owned atomic fault'))
            : Promise.resolve(),
      },
    });
    const before = await facts();
    await expect(db.importWorkflow(command())).rejects.toThrow(
      'owned atomic fault',
    );
    expect(await facts()).toEqual(before);
  });

  it('requires fresh compatibility preview, exact graph requirements and new-placement authority', async () => {
    const db = database();
    const before = await facts();
    await expect(
      db.importWorkflow(
        command({
          expectedCompatibilityFingerprint: `node-compat:v1:sha256:${'0'.repeat(64)}`,
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowPortabilityCompatibilityConflictError);
    const input = command();
    await expect(
      db.importWorkflow({
        ...input,
        manifest: {
          ...input.manifest,
          requirements: {
            ...input.manifest.requirements,
            definitions: [
              { key: 'test.placeholder', version: 1, configVersion: 1 },
            ],
          },
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowPortabilityValidationError);
    expect(await facts()).toEqual(before);
  });

  it('exports only the exact reviewed saved source; source changes require a new acknowledgement', async () => {
    const db = database();
    const created = await db.createWorkflow({
      workspaceId,
      actorId,
      name: 'Reviewed export',
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const input = {
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      source: { kind: 'draft' as const },
      reviewedGraphDigest: await portableGraphDigest(
        parseWorkflowGraphDraft(emptyGraph),
      ),
      representationTag: await currentRepresentationTag(
        db,
        workspaceId,
        created.workflowId,
        actorId,
      ),
    };
    expect(await db.exportWorkflow(input)).toEqual(command().manifest);
    const publication = await authoring.publishWorkflow({
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        created.workflowId,
        actorId,
      ),
      requestHash: 'f'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(
      await db.exportWorkflow({
        ...input,
        source: { kind: 'version', versionId: publication.version.id },
      }),
    ).toEqual(command().manifest);
    await expect(
      db.exportWorkflow({ ...input, reviewedGraphDigest: '0'.repeat(64) }),
    ).rejects.toBeInstanceOf(WorkflowPortabilityReviewConflictError);
    await saveCurrentDraft(db, {
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 1000 } },
    });
    await expect(db.exportWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowRevisionConflictError,
    );
    await expect(
      db.exportWorkflow({
        ...input,
        source: { kind: 'version', versionId: otherVersionId },
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      db.exportWorkflow({ ...input, actorId: otherActorId }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it('preserves nested graph identity and expressions, rebinds explicit destination slots and never accesses secret bytes', async () => {
    const connections = createConnectionDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    const scopedCatalog = {
      ...catalog,
      definitions: [
        ...catalog.definitions,
        { key: 'core.foreach', version: 1 },
      ],
    };
    const scopedPortableCatalog = {
      ...portableCatalog,
      definitions: [
        {
          key: 'test.placeholder',
          version: 1,
          configVersion: 1,
          slots: [
            { slot: 'account', providerKey: 'http', authType: 'http_headers' },
          ],
          validateConfig: () => true,
        },
        {
          key: 'core.foreach',
          version: 1,
          configVersion: 1,
          slots: [],
          validateConfig: () => true,
        },
      ],
    };
    const db = database({
      definitionCatalog: scopedCatalog,
      placementDefinitionCatalog: scopedCatalog,
      portableCatalog: scopedPortableCatalog,
    });
    const destinationConnection = randomUUID(),
      foreignConnection = randomUUID();
    const createConnection = (id: string, workspace: string, actor: string) =>
      connections.createConnection({
        workspaceId: workspace,
        actorId: actor,
        connectionId: id,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: `Portability ${id}`,
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        idempotencyKey: randomUUID(),
        requestHash: createHash('sha256').update(id).digest('hex'),
        sealed: {
          schemaVersion: 1,
          kmsKeyReference: 'arn:aws:kms:region:account:key/portability',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('never-export-secret').toString('base64url'),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
      });
    try {
      await createConnection(destinationConnection, workspaceId, actorId);
      await createConnection(foreignConnection, otherWorkspaceId, otherActorId);
      const graph = parseWorkflowGraphDraft({
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('loop'),
            definition: { key: 'core.foreach', version: 1 },
            structured: {
              kind: 'for_each',
              maxIterations: 10,
              maxConcurrency: 2,
              body: {
                ...emptyGraph,
                inputPorts: ['item', 'ordinal'],
                outputPorts: ['result'],
                nodes: [
                  {
                    ...draftNode('nested'),
                    inputMappings: {
                      value: {
                        kind: 'expression',
                        language: 'jsonata',
                        policyVersion: 1,
                        expression:
                          '$lookup(nodeOutputs, runInput.stepId).value',
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      });
      const manifest = projectWorkflowPortableManifest(
        graph,
        scopedPortableCatalog,
      );
      expect(manifest.connectionSlots).toEqual([
        {
          nodeId: 'nested',
          slot: 'account',
          providerKey: 'http',
          authType: 'http_headers',
        },
      ]);
      const input = command({
        manifest,
        bindings: [
          {
            nodeId: 'nested',
            slot: 'account',
            connectionId: destinationConnection,
          },
        ],
      });
      expect(
        (
          await db.previewWorkflowImport({
            ...inputForPreview(input),
            bindings: [],
          })
        ).compatible,
      ).toBe(false);
      for (const id of [foreignConnection, randomUUID()]) {
        await expect(
          db.importWorkflow({
            ...input,
            idempotencyKey: randomUUID(),
            bindings: [{ nodeId: 'nested', slot: 'account', connectionId: id }],
          }),
        ).rejects.toBeInstanceOf(WorkflowPortabilityValidationError);
      }
      const accepted = await db.importWorkflow(input);
      const draft = await db.getDraft(
        workspaceId,
        accepted.workflowId,
        actorId,
      );
      const expected = structuredClone(graph);
      const loop = expected.nodes[0];
      if (loop?.structured?.body.nodes[0] === undefined)
        throw new Error('Expected structured fixture');
      const rebound = {
        ...expected,
        nodes: [
          {
            ...loop,
            structured: {
              ...loop.structured,
              body: {
                ...loop.structured.body,
                nodes: [
                  {
                    ...loop.structured.body.nodes[0],
                    connectionRefs: { account: destinationConnection },
                  },
                ],
              },
            },
          },
        ],
      };
      expect(draft?.graphJson).toEqual(rebound);
      const secretAccess = await queryAsOwner(
        "select action from app.audit_events where workspace_id=$1 and action like '%credential_accessed%'",
        [workspaceId],
        workspaceId,
      );
      expect(secretAccess).toEqual([]);
      await connections.revokeConnection({
        workspaceId,
        actorId,
        connectionId: destinationConnection,
      });
      expect(await db.importWorkflow(input)).toEqual(accepted);
      await expect(
        db.importWorkflow({ ...input, idempotencyKey: randomUUID() }),
      ).rejects.toBeInstanceOf(WorkflowPortabilityValidationError);
    } finally {
      await connections.close();
    }
  });

  it.each(['app.workflows', 'app.workflow_drafts'] as const)(
    'rolls back creator-internal writes if %s insertion fails',
    async (table) => {
      const db = database();
      const name = `portable_fault_${randomUUID().replaceAll('-', '')}`;
      await executeAsOwner(
        `create function app.${name}() returns trigger language plpgsql as $$begin raise exception 'owned creator insertion fault'; end$$; create trigger ${name} before insert on ${table} for each row execute function app.${name}()`,
      );
      try {
        const before = await facts();
        await expect(db.importWorkflow(command())).rejects.toThrow(
          'owned creator insertion fault',
        );
        expect(await facts()).toEqual(before);
      } finally {
        await executeAsOwner(
          `drop trigger ${name} on ${table}; drop function app.${name}()`,
        );
      }
    },
  );

  it('holds ordered authority/catalog locks until import commits so later writers lose the race', async () => {
    for (const surface of [
      'workspace',
      'actor',
      'membership',
      'gate',
    ] as const) {
      const entered = deferred(),
        released = deferred();
      const db = database({
        testHooks: {
          afterImportStep: async (step) => {
            if (step === 'catalog') {
              entered.resolve();
              await released.promise;
            }
          },
        },
      });
      const application = `portable-${surface}-${randomUUID()}`;
      const pool = new Pool({
        connectionString: withApplicationName(migrationUrl, application),
        max: 1,
      });
      const owner = await pool.connect();
      let operation: Promise<unknown> | undefined,
        writer: Promise<unknown> | undefined,
        primaryError: unknown;
      try {
        operation = db.importWorkflow(command());
        await waitForOperationEntry(
          entered.promise,
          operation,
          'portable admission',
        );
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        const sql = {
          workspace: 'update app.workspaces set name=name where id=$1',
          actor: 'update app.users set display_name=display_name where id=$1',
          membership:
            'update app.workspace_memberships set role=role where workspace_id=$1 and user_id=$2',
          gate: 'update app.workflow_portability_rollout set import_enabled=import_enabled where singleton',
        }[surface];
        writer = owner.query(
          sql,
          sql.includes('$2')
            ? [workspaceId, actorId]
            : sql.includes('$1')
              ? [surface === 'actor' ? actorId : workspaceId]
              : [],
        );
        await waitForPostgresLock(application);
        released.resolve();
        await operation;
        await writer;
        await owner.query('rollback');
      } catch (error) {
        primaryError = error;
      } finally {
        released.resolve();
        await Promise.allSettled(
          [operation, writer].filter((value) => value !== undefined),
        );
        await finishTransactionClient(owner, {
          label: 'portable writer',
          primaryError,
          transactionOpen: true,
        });
        await finishControlledScenario({
          label: 'portable race',
          primaryError,
          operations: [],
          release: released.resolve,
          close: [() => pool.end()],
        });
      }
    }
  });

  it('rechecks authority after a workspace/member writer wins and fences completed replay', async () => {
    const db = database();
    const input = command();
    await db.importWorkflow(input);
    await queryAsOwner(
      "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
      [workspaceId, actorId],
      workspaceId,
    );
    try {
      await expect(db.importWorkflow(input)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
    } finally {
      await queryAsOwner(
        "update app.workspace_memberships set role='owner' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
        workspaceId,
      );
    }
  });

  it('lets a workspace-first membership writer invalidate a blocked new command', async () => {
    const application = `portable-member-first-${randomUUID()}`;
    const db = database({}, withApplicationName(apiUrl, application));
    const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
    const owner = await ownerPool.connect();
    let pending: Promise<unknown> | undefined, primaryError: unknown;
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'select id from app.workspaces where id=$1 for update',
        [workspaceId],
      );
      await owner.query(
        "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
      );
      pending = db.importWorkflow(command());
      const rejected = expect(pending).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
      await waitForPostgresLock(application);
      await owner.query('commit');
      await rejected;
    } catch (error) {
      primaryError = error;
    } finally {
      await finishTransactionClient(owner, {
        label: 'portable membership writer',
        primaryError,
        transactionOpen: true,
      });
      await Promise.allSettled(pending === undefined ? [] : [pending]);
      await queryAsOwner(
        "update app.workspace_memberships set role='owner' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
        workspaceId,
      );
      await ownerPool.end();
    }
  });

  it('serializes connection revocation in both orders and permits accepted replay after health loss', async () => {
    const connectionApplication = `portable-connection-${randomUUID()}`;
    const connections = createConnectionDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, connectionApplication),
        max: 2,
      }),
    );
    const providerCatalog: WorkflowPortabilityCatalog = {
      ...portableCatalog,
      definitions: [
        {
          key: 'test.placeholder',
          version: 1,
          configVersion: 1,
          slots: [
            { slot: 'account', providerKey: 'http', authType: 'http_headers' },
          ],
          validateConfig: () => true,
        },
      ],
    };
    const makeConnection = async () => {
      const id = randomUUID();
      await connections.createConnection({
        workspaceId,
        actorId,
        connectionId: id,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: `Portable race ${id}`,
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        idempotencyKey: randomUUID(),
        requestHash: createHash('sha256').update(id).digest('hex'),
        sealed: {
          schemaVersion: 1,
          kmsKeyReference: 'arn:aws:kms:region:account:key/portability-race',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('connection-race-secret').toString(
            'base64url',
          ),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
      });
      return id;
    };
    const entered = deferred(),
      released = deferred();
    const winner = database({
      portableCatalog: providerCatalog,
      testHooks: {
        afterImportStep: async (step) => {
          if (step === 'connections') {
            entered.resolve();
            await released.promise;
          }
        },
      },
    });
    let accepted: Promise<{ workflowId: string }> | undefined,
      revoked: Promise<unknown> | undefined,
      primaryError: unknown;
    try {
      const firstConnection = await makeConnection();
      const manifest = projectWorkflowPortableManifest(
        parseWorkflowGraphDraft({
          ...emptyGraph,
          nodes: [draftNode('provider')],
        }),
        providerCatalog,
      );
      const first = command({
        manifest,
        bindings: [
          {
            nodeId: 'provider',
            slot: 'account',
            connectionId: firstConnection,
          },
        ],
      });
      accepted = winner.importWorkflow(first);
      await waitForOperationEntry(
        entered.promise,
        accepted,
        'portable connection admission',
      );
      revoked = connections.revokeConnection({
        workspaceId,
        actorId,
        connectionId: firstConnection,
      });
      await waitForPostgresLock(connectionApplication);
      released.resolve();
      const result = await accepted;
      await revoked;
      expect(await winner.importWorkflow(first)).toEqual(result);
      const secondConnection = await makeConnection();
      const secondApplication = `portable-binding-first-${randomUUID()}`;
      const loser = database(
        { portableCatalog: providerCatalog },
        withApplicationName(apiUrl, secondApplication),
      );
      const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
      const owner = await ownerPool.connect();
      let pending: Promise<unknown> | undefined, ownerError: unknown;
      try {
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query(
          "select set_config('app.workspace_id',$1,true),set_config('app.connection_health_protocol','1',true)",
          [workspaceId],
        );
        await owner.query('select app.lock_workspace_run_admission($1)', [
          workspaceId,
        ]);
        await owner.query(
          "update app.connections set status='revoked',health_revision=health_revision+1,last_health_transition_at=clock_timestamp(),last_health_transition_source='revoke' where workspace_id=$1 and id=$2",
          [workspaceId, secondConnection],
        );
        pending = loser.importWorkflow(
          command({
            manifest,
            bindings: [
              {
                nodeId: 'provider',
                slot: 'account',
                connectionId: secondConnection,
              },
            ],
          }),
        );
        const rejected = expect(pending).rejects.toBeInstanceOf(
          WorkflowPortabilityValidationError,
        );
        await waitForPostgresLock(secondApplication);
        await owner.query('commit');
        await rejected;
      } catch (error) {
        ownerError = error;
      } finally {
        await finishTransactionClient(owner, {
          label: 'portable connection writer',
          primaryError: ownerError,
          transactionOpen: true,
        });
        await Promise.allSettled(pending === undefined ? [] : [pending]);
        await ownerPool.end();
      }
    } catch (error) {
      primaryError = error;
    } finally {
      await finishControlledScenario({
        label: 'portable connection races',
        primaryError,
        operations: [accepted, revoked],
        release: released.resolve,
        close: [() => connections.close()],
      });
    }
  });

  it('retains actor-only receipts under legal hold, reaps expiry and erases import through ordinary bounded workspace purge', async () => {
    const db = database();
    const workspace = await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      name: 'Portable hold/purge',
      slug: `portable-purge-${randomUUID()}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    });
    const scoped = workspace.id;
    const input = command({ workspaceId: scoped });
    const accepted = await db.importWorkflow(input);
    const hold = randomUUID();
    await queryAsOwner(
      "select app.project_workspace_legal_hold($1,1,$2,'legal_hold_placed',$3,$4,$5,'owned-portable','portable-case','Preserve import receipt',clock_timestamp())",
      [scoped, randomUUID(), hold, '0'.repeat(64), 'b'.repeat(64)],
      scoped,
    );
    await queryAsOwner(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.import'",
      [scoped],
      scoped,
    );
    await queryAsOwner('select * from app.reap_transient_data(1000)');
    const retained = await queryAsOwner(
      "select scope,resource_id::text,result_ref from app.idempotency_records where workspace_id=$1 and operation='workflow.import'",
      [scoped],
      scoped,
    );
    expect(retained).toEqual([
      {
        scope: actorId,
        resource_id: accepted.workflowId,
        result_ref: accepted,
      },
    ]);
    expect(await db.importWorkflow(input)).toEqual(accepted);
    await queryAsOwner(
      "select app.project_workspace_legal_hold($1,2,$2,'legal_hold_released',$3,$4,$5,'owned-portable','portable-case','Release import receipt',clock_timestamp())",
      [scoped, randomUUID(), hold, 'b'.repeat(64), 'c'.repeat(64)],
      scoped,
    );
    await queryAsOwner('select * from app.reap_transient_data(1000)');
    expect(
      await queryAsOwner(
        "select id from app.idempotency_records where workspace_id=$1 and operation='workflow.import'",
        [scoped],
        scoped,
      ),
    ).toEqual([]);
    const fresh = await db.importWorkflow(input);
    expect(fresh.workflowId).not.toBe(accepted.workflowId);
    await queryAsOwner(
      "select app.project_workspace_deletion($1,3,$2,'deletion_requested',$1,$3,$4,$5,null,'Portable import erasure',clock_timestamp()-interval '31 days')",
      [scoped, randomUUID(), 'c'.repeat(64), 'd'.repeat(64), actorId],
      scoped,
    );
    const [job] = await queryAsOwner<{
      job_id: string;
      lease_token: string;
      lease_fence: string;
    }>(
      "select * from app.prepare_workspace_purge_job($1,3,$2,'owned-portable',interval '1 minute')",
      [scoped, 'd'.repeat(64)],
      scoped,
    );
    if (job === undefined) throw new Error('Expected portability purge job');
    await queryAsOwner(
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
    const [object] = await queryAsOwner<{
      lease_token: string;
      lease_fence: string;
      step_name: string;
    }>(
      "select * from app.claim_workspace_purge_step($1,4,$2,'owned-portable',interval '1 minute')",
      [job.job_id, 'e'.repeat(64)],
      scoped,
    );
    if (object === undefined)
      throw new Error('Expected portability object purge lease');
    expect(object.step_name).toBe('object_versions');
    await queryAsOwner(
      'select app.checkpoint_workspace_object_versions_page($1,$2,$3,0,true,4,$4)',
      [job.job_id, object.lease_token, object.lease_fence, 'e'.repeat(64)],
      scoped,
    );
    let completed = false;
    for (let page = 0; page < 100 && !completed; page += 1) {
      const [claim] = await queryAsOwner<{
        lease_token: string;
        lease_fence: string;
        step_name: string;
      }>(
        "select * from app.claim_workspace_purge_step($1,4,$2,'owned-portable',interval '1 minute')",
        [job.job_id, 'e'.repeat(64)],
        scoped,
      );
      if (claim === undefined)
        throw new Error('Expected portability tenant purge lease');
      expect(claim.step_name).toBe('tenant_rows');
      const rows = await queryAsOwner<{ completed: boolean }>(
        'select * from app.execute_workspace_tenant_rows_page($1,$2,$3,500,4,$4)',
        [job.job_id, claim.lease_token, claim.lease_fence, 'e'.repeat(64)],
        scoped,
      );
      completed = rows[0]?.completed === true;
    }
    expect(completed).toBe(true);
    expect(
      await queryAsOwner(
        `select (select count(*)::int from app.idempotency_records where workspace_id=$1) receipts,
      (select count(*)::int from app.workflows where workspace_id=$1) workflows,
      (select count(*)::int from app.workflow_drafts where workspace_id=$1) drafts`,
        [scoped],
        scoped,
      ),
    ).toEqual([{ receipts: 0, workflows: 0, drafts: 0 }]);
    await expect(db.importWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });

  it('skips an expired completed receipt while an exact retry holds its claim lock', async () => {
    const db = database();
    const input = command();
    const accepted = await db.importWorkflow(input);
    await queryAsOwner(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.import' and resource_id=$2",
      [workspaceId, accepted.workflowId],
      workspaceId,
    );
    const entered = deferred(),
      released = deferred();
    const retry = database({
      testHooks: {
        afterImportStep: async (step) => {
          if (step === 'claim') {
            entered.resolve();
            await released.promise;
          }
        },
      },
    });
    let pending: Promise<unknown> | undefined, primaryError: unknown;
    try {
      pending = retry.importWorkflow(input);
      await waitForOperationEntry(
        entered.promise,
        pending,
        'locked expired import receipt',
      );
      await queryAsOwner('select * from app.reap_transient_data(1000)');
      expect(
        await queryAsOwner(
          "select resource_id::text from app.idempotency_records where workspace_id=$1 and operation='workflow.import' and resource_id=$2",
          [workspaceId, accepted.workflowId],
          workspaceId,
        ),
      ).toEqual([{ resource_id: accepted.workflowId }]);
      released.resolve();
      expect(await pending).toEqual(accepted);
      await queryAsOwner('select * from app.reap_transient_data(1000)');
      expect(
        await queryAsOwner(
          "select resource_id from app.idempotency_records where workspace_id=$1 and operation='workflow.import' and resource_id=$2",
          [workspaceId, accepted.workflowId],
          workspaceId,
        ),
      ).toEqual([]);
    } catch (error) {
      primaryError = error;
    } finally {
      await finishControlledScenario({
        label: 'expired locked import claim',
        primaryError,
        operations: [pending],
        release: released.resolve,
        close: [],
      });
    }
  });

  it('exports the reviewed draft snapshot before a later save wins its draft UPDATE', async () => {
    const entered = deferred(),
      released = deferred();
    const reader = database({
      testHooks: {
        afterExportSourceLock: async () => {
          entered.resolve();
          await released.promise;
        },
      },
    });
    const saveApplication = `portable-save-${randomUUID()}`;
    const writer = database({}, withApplicationName(apiUrl, saveApplication));
    const source = await reader.createWorkflow({
      workspaceId,
      actorId,
      name: 'Export/save race',
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const tag = await currentRepresentationTag(
      reader,
      workspaceId,
      source.workflowId,
      actorId,
    );
    let exported: Promise<unknown> | undefined,
      saved: Promise<unknown> | undefined,
      primaryError: unknown;
    try {
      exported = reader.exportWorkflow({
        workspaceId,
        actorId,
        workflowId: source.workflowId,
        source: { kind: 'draft' },
        representationTag: tag,
        reviewedGraphDigest: await portableGraphDigest(
          parseWorkflowGraphDraft(emptyGraph),
        ),
      });
      await waitForOperationEntry(
        entered.promise,
        exported,
        'locked portable source',
      );
      saved = writer.saveDraft({
        workspaceId,
        actorId,
        workflowId: source.workflowId,
        representationTag: tag,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 2000 } },
      });
      await waitForPostgresLock(saveApplication);
      released.resolve();
      expect(await exported).toEqual(command().manifest);
      await saved;
      expect(
        (await writer.getDraft(workspaceId, source.workflowId, actorId))
          ?.graphJson.settings,
      ).toEqual({ maxRunDurationMs: 2000 });
    } catch (error) {
      primaryError = error;
    } finally {
      await finishControlledScenario({
        label: 'portable export/save race',
        primaryError,
        operations: [exported, saved],
        release: released.resolve,
        close: [],
      });
    }
  });

  it('fails closed on a missing accepted destination rather than creating a second workflow', async () => {
    const db = database();
    const input = command();
    const accepted = await db.importWorkflow(input);
    await queryAsOwner(
      'delete from app.workflow_drafts where workspace_id=$1 and workflow_id=$2',
      [workspaceId, accepted.workflowId],
      workspaceId,
    );
    await queryAsOwner(
      'delete from app.workflows where workspace_id=$1 and id=$2',
      [workspaceId, accepted.workflowId],
      workspaceId,
    );
    const before = await facts();
    await expect(db.importWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    expect(await facts()).toEqual(before);
  });

  it('qualifies the API-only creator and rejects SQL-level graph substitution under an exact claim', async () => {
    expect((await checkDatabaseReadiness(apiPool)).role).toBe('pertexo_api');
    const db = database({
      testHooks: {
        afterImportStep: (step) =>
          step === 'connections'
            ? Promise.reject(new Error('claim probe'))
            : Promise.resolve(),
      },
    });
    await expect(db.importWorkflow(command())).rejects.toThrow('claim probe');
    const client = await apiPool.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
        [workspaceId, actorId],
      );
      const input = command(),
        destination = randomUUID(),
        keyHash = createHash('sha256')
          .update(input.idempotencyKey)
          .digest('hex');
      const text = canonicalWorkflowPortableJson({
        name: input.name,
        manifest: input.manifest,
        bindings: [],
        expectedCompatibilityFingerprint:
          input.expectedCompatibilityFingerprint,
      });
      const requestHash = createHash('sha256').update(text).digest('hex');
      await client.query(
        "insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref) values($1,$2,'workflow.import',$3,$4,$5,'in_progress',$6,'{}')",
        [randomUUID(), workspaceId, actorId, keyHash, requestHash, destination],
      );
      await expect(
        client.query(
          'select app.create_workflow_import_draft($1,$2,$3,$4::jsonb,$5,$6,$7)',
          [
            destination,
            workspaceId,
            actorId,
            JSON.stringify({
              ...emptyGraph,
              settings: { maxRunDurationMs: 1000 },
            }),
            keyHash,
            requestHash,
            text,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it.each([
    { schemaVersion: 1 },
    { ...emptyGraph, nodes: null },
    { ...emptyGraph, edges: null },
    { ...emptyGraph, settings: [] },
    {
      ...emptyGraph,
      nodes: [{ id: 'not-an-authoring-node', connectionRefs: {} }],
    },
  ])(
    'rejects a direct creator claim with malformed source graph %# without persisting facts',
    async (graph) => {
      const before = await facts();
      const client = await apiPool.connect();
      try {
        await client.query('begin');
        await client.query(
          "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
          [workspaceId, actorId],
        );
        const input = command(),
          destination = randomUUID(),
          keyHash = createHash('sha256')
            .update(input.idempotencyKey)
            .digest('hex');
        const text = JSON.stringify({
          name: input.name,
          manifest: { ...input.manifest, graph },
          bindings: [],
          expectedCompatibilityFingerprint:
            input.expectedCompatibilityFingerprint,
        });
        const requestHash = createHash('sha256').update(text).digest('hex');
        await client.query(
          "insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref) values($1,$2,'workflow.import',$3,$4,$5,'in_progress',$6,'{}')",
          [
            randomUUID(),
            workspaceId,
            actorId,
            keyHash,
            requestHash,
            destination,
          ],
        );
        await expect(
          client.query(
            'select app.create_workflow_import_draft($1,$2,$3,$4::jsonb,$5,$6,$7)',
            [
              destination,
              workspaceId,
              actorId,
              JSON.stringify(graph),
              keyHash,
              requestHash,
              text,
            ],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('rollback');
        client.release();
      }
      expect(await facts()).toEqual(before);
    },
  );
});

function inputForPreview(input: ImportWorkflowInput) {
  return {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    manifest: input.manifest,
    bindings: input.bindings,
  };
}
