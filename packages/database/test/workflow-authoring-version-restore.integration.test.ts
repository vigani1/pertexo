import { describe, expect, it } from 'vitest';
import {
  BASELINE_COMPATIBILITY_EXPECTATION,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  actorId,
  apiPool,
  apiUrl,
  authoring,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  deferred,
  draftNode,
  emptyGraph,
  otherActorId,
  otherVersionId,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  testDefinitionCatalog,
  waitForPostgresLock,
  workflowDraftRepresentationTag,
  workspaceId,
  withApplicationName,
} from './support/workflow-authoring.integration.support.js';
import { workflowRetainedExecutableChecksum } from '@pertexo/workflow-model/graph';

type RestoreFixture = Readonly<{
  workflowId: string;
  firstVersionId: string;
  secondVersionId: string;
  currentGraph: ReturnType<typeof graphWithDuration>;
}>;

function graphWithDuration(duration: number) {
  return { ...emptyGraph, settings: { maxRunDurationMs: duration } };
}

const blockedDefinitionCatalog = Object.freeze({
  schemaVersion: 1 as const,
  releaseFingerprint: BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
  definitions: Object.freeze([
    Object.freeze({ key: 'test.blocked', version: 1 }),
  ]),
});

const currentDefinitionCatalog = Object.freeze({
  ...testDefinitionCatalog,
  releaseFingerprint: BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
});

async function createRestoreFixture(
  name: string,
  database = authoring,
): Promise<RestoreFixture> {
  const created = await database.createWorkflow({
    actorId,
    emptyGraph,
    idempotencyKey: `restore-create-${name}`,
    name: `Restore ${name}`,
    workspaceId,
  });
  const first = await database.publishWorkflow({
    actorId,
    representationTag: await currentRepresentationTag(
      database,
      workspaceId,
      created.workflowId,
      actorId,
    ),
    idempotencyKey: `restore-publish-first-${name}`,
    requestHash: '1'.repeat(64),
    workflowId: created.workflowId,
    workspaceId,
  });
  const firstGraph = graphWithDuration(1_000);
  await database.saveDraft({
    actorId,
    expectedRevision: 1,
    graphJson: firstGraph,
    workflowId: created.workflowId,
    workspaceId,
  });
  const second = await database.publishWorkflow({
    actorId,
    representationTag: await currentRepresentationTag(
      database,
      workspaceId,
      created.workflowId,
      actorId,
    ),
    idempotencyKey: `restore-publish-second-${name}`,
    requestHash: '2'.repeat(64),
    workflowId: created.workflowId,
    workspaceId,
  });
  const currentGraph = graphWithDuration(2_000);
  await database.saveDraft({
    actorId,
    expectedRevision: 2,
    graphJson: currentGraph,
    workflowId: created.workflowId,
    workspaceId,
  });
  return Object.freeze({
    workflowId: created.workflowId,
    firstVersionId: first.version.id,
    secondVersionId: second.version.id,
    currentGraph,
  });
}

async function restoreInput(
  fixture: RestoreFixture,
  database = authoring,
  representationTag?: string,
) {
  return {
    actorId,
    representationTag:
      representationTag ??
      (await currentRepresentationTag(
        database,
        workspaceId,
        fixture.workflowId,
        actorId,
      )),
    versionId: fixture.firstVersionId,
    workflowId: fixture.workflowId,
    workspaceId,
  } as const;
}

async function restoreFacts(scopedWorkflowId: string) {
  const rows = await queryAsOwner<{
    draft_graph: unknown;
    draft_revision: number;
    first_version_graph: unknown;
    first_version_checksum: string | null;
    pointer: string | null;
    versions: number;
    outbox: number;
    publication_audits: number;
    restore_audits: number;
  }>(
    `select draft.revision as draft_revision,
            draft.graph_json as draft_graph,
            (select version.graph_json from app.workflow_versions version
              where version.workflow_id=$1 order by version.version_number limit 1)
              as first_version_graph,
            (select version.checksum from app.workflow_versions version
              where version.workflow_id=$1 order by version.version_number limit 1)
              as first_version_checksum,
            workflow.published_version_id::text as pointer,
            (select count(*)::int from app.workflow_versions version
              where version.workflow_id=$1) as versions,
            (select count(*)::int from app.outbox_events event
              where event.aggregate_id=$1) as outbox,
            (select count(*)::int from app.audit_events event
              where event.target_id=$1 and event.action='workflow.published')
              as publication_audits,
            (select count(*)::int from app.audit_events event
              where event.target_id=$1 and event.action='workflow.version_restored')
              as restore_audits
       from app.workflow_drafts draft
       join app.workflows workflow
         on workflow.workspace_id=draft.workspace_id
        and workflow.id=draft.workflow_id
      where draft.workflow_id=$1`,
    [scopedWorkflowId],
    workspaceId,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('Expected restore facts');
  return row;
}

async function insertSucceededRun(
  scopedWorkflowId: string,
  versionId: string,
): Promise<string> {
  const runId = randomUUID();
  const client = await apiPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await client.query(
      `insert into app.workflow_runs
         (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
          execution_entitlement_version)
       values($1,$2,$3,$4,'manual','succeeded',1)`,
      [runId, workspaceId, scopedWorkflowId, versionId],
    );
    await client.query('commit');
    return runId;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function persistedRun(runId: string): Promise<string> {
  const client = await apiPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await client.query<{ value: string }>(
      'select row_to_json(run)::text value from app.workflow_runs run where id=$1',
      [runId],
    );
    await client.query('commit');
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Expected nonempty retained run');
    return row.value;
  } finally {
    await client.query('rollback');
    client.release();
  }
}

describe('workflow version restoration persistence', () => {
  it('copies the exact retained graph, advances once, audits identity, preserves history, and rejects retry', async () => {
    const fixture = await createRestoreFixture('copy-history');
    const runId = await insertSucceededRun(
      fixture.workflowId,
      fixture.secondVersionId,
    );
    const before = await restoreFacts(fixture.workflowId);
    const priorRun = await persistedRun(runId);
    const tag = await currentRepresentationTag(
      authoring,
      workspaceId,
      fixture.workflowId,
      actorId,
    );
    const restored = await authoring.restoreWorkflowVersion({
      ...(await restoreInput(fixture, authoring, tag)),
      requestId: 'restore-request',
      traceId: 'restore-trace',
    });
    expect(restored).toMatchObject({
      graphJson: emptyGraph,
      revision: before.draft_revision + 1,
    });
    expect(await restoreFacts(fixture.workflowId)).toMatchObject({
      draft_graph: emptyGraph,
      draft_revision: before.draft_revision + 1,
      first_version_graph: emptyGraph,
      first_version_checksum: before.first_version_checksum,
      pointer: fixture.secondVersionId,
      versions: before.versions,
      outbox: before.outbox,
      publication_audits: before.publication_audits,
      restore_audits: before.restore_audits + 1,
    });
    expect(
      await queryAsOwner<{
        source_version_id: string;
        previous_revision: number;
        revision: number;
      }>(
        `select metadata->>'sourceVersionId' source_version_id,
                (metadata->>'previousRevision')::int previous_revision,
                (metadata->>'revision')::int revision
           from app.audit_events
          where target_id=$1 and action='workflow.version_restored'`,
        [fixture.workflowId],
        workspaceId,
      ),
    ).toEqual([
      {
        source_version_id: fixture.firstVersionId,
        previous_revision: before.draft_revision,
        revision: before.draft_revision + 1,
      },
    ]);
    expect(await persistedRun(runId)).toEqual(priorRun);
    await expect(
      authoring.restoreWorkflowVersion(
        await restoreInput(fixture, authoring, tag),
      ),
    ).rejects.toBeInstanceOf(WorkflowRevisionConflictError);
    await expect(
      authoring.getDraft(workspaceId, fixture.workflowId, actorId),
    ).resolves.toMatchObject({
      revision: before.draft_revision + 1,
      graphJson: emptyGraph,
    });
  });

  it('uses the whole strong tag, including the current catalog, and keeps failure paths mutation-free', async () => {
    const fixture = await createRestoreFixture('tag');
    const draft = await authoring.getDraft(
      workspaceId,
      fixture.workflowId,
      actorId,
    );
    if (draft === null) throw new Error('Expected draft');
    const forged = workflowDraftRepresentationTag({
      workflowId: fixture.workflowId,
      revision: draft.revision,
      graph: graphWithDuration(1_000),
      compatibilityFingerprint: draft.compatibility.fingerprint,
    });
    await expect(
      authoring.restoreWorkflowVersion(
        await restoreInput(fixture, authoring, forged),
      ),
    ).rejects.toMatchObject({ currentRevision: draft.revision });
    const before = await restoreFacts(fixture.workflowId);
    const changedCatalog = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      { definitionCatalog: testDefinitionCatalog },
    );
    try {
      const oldTag = await currentRepresentationTag(
        authoring,
        workspaceId,
        fixture.workflowId,
        actorId,
      );
      await expect(
        changedCatalog.restoreWorkflowVersion(
          await restoreInput(fixture, changedCatalog, oldTag),
        ),
      ).rejects.toMatchObject({ currentRevision: draft.revision });
    } finally {
      await changedCatalog.close();
    }
    expect(await restoreFacts(fixture.workflowId)).toEqual(before);
    await expect(
      authoring.restoreWorkflowVersion({
        ...(await restoreInput(fixture)),
        representationTag: '',
      }),
    ).rejects.toThrow();
    expect(await restoreFacts(fixture.workflowId)).toEqual(before);
  });

  it('enforces active author scope and source workspace/workflow identity', async () => {
    const fixture = await createRestoreFixture('scope');
    const sameWorkspace = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'restore-scope-other-workflow',
      name: 'Other restore source workflow',
      workspaceId,
    });
    const sameWorkspaceVersion = await authoring.publishWorkflow({
      actorId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        sameWorkspace.workflowId,
        actorId,
      ),
      idempotencyKey: 'restore-scope-other-workflow-publish',
      requestHash: '3'.repeat(64),
      workflowId: sameWorkspace.workflowId,
      workspaceId,
    });
    const tag = await currentRepresentationTag(
      authoring,
      workspaceId,
      fixture.workflowId,
      actorId,
    );
    for (const sourceVersionId of [
      sameWorkspaceVersion.version.id,
      otherVersionId,
      randomUUID(),
    ]) {
      await expect(
        authoring.restoreWorkflowVersion({
          actorId,
          representationTag: tag,
          versionId: sourceVersionId,
          workflowId: fixture.workflowId,
          workspaceId,
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    }
    await expect(
      authoring.restoreWorkflowVersion({
        actorId: otherActorId,
        representationTag: tag,
        versionId: fixture.firstVersionId,
        workflowId: fixture.workflowId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await authoring.transitionWorkflowLifecycle({
      actorId,
      command: 'archive',
      expectedLifecycleRevision: 1,
      idempotencyKey: 'restore-scope-archive',
      workflowId: fixture.workflowId,
      workspaceId,
    });
    await expect(
      authoring.restoreWorkflowVersion({
        actorId,
        representationTag: tag,
        versionId: fixture.firstVersionId,
        workflowId: fixture.workflowId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it('applies the existing placeability rule to retained graphs', async () => {
    const sourceAuthoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        compatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
        definitionCatalog: blockedDefinitionCatalog,
        placementDefinitionCatalog: blockedDefinitionCatalog,
      },
    );
    const rejectingAuthoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        compatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
        definitionCatalog: currentDefinitionCatalog,
        placementDefinitionCatalog: currentDefinitionCatalog,
      },
    );
    try {
      const created = await sourceAuthoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: 'restore-blocked-create',
        name: 'Restore blocked definition',
        workspaceId,
      });
      const blockedGraph = {
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('blocked'),
            definition: { key: 'test.blocked', version: 1 },
          },
        ],
      };
      await sourceAuthoring.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: blockedGraph,
        workflowId: created.workflowId,
        workspaceId,
      });
      const blockedVersion = await sourceAuthoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          sourceAuthoring,
          workspaceId,
          created.workflowId,
          actorId,
          blockedDefinitionCatalog,
        ),
        idempotencyKey: 'restore-blocked-publish',
        requestHash: '5'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      await sourceAuthoring.saveDraft({
        actorId,
        expectedRevision: 2,
        graphJson: emptyGraph,
        workflowId: created.workflowId,
        workspaceId,
      });
      const before = await restoreFacts(created.workflowId);
      await expect(
        rejectingAuthoring.restoreWorkflowVersion({
          actorId,
          representationTag: await currentRepresentationTag(
            rejectingAuthoring,
            workspaceId,
            created.workflowId,
            actorId,
            currentDefinitionCatalog,
          ),
          versionId: blockedVersion.version.id,
          workflowId: created.workflowId,
          workspaceId,
        }),
      ).rejects.toThrow('Workflow draft adds a definition');
      expect(await restoreFacts(created.workflowId)).toEqual(before);
    } finally {
      await Promise.all([sourceAuthoring.close(), rejectingAuthoring.close()]);
    }
  });

  it('rolls back source, draft, and audit failures as one transaction', async () => {
    for (const step of ['source', 'draft', 'audit'] as const) {
      const fixture = await createRestoreFixture(`rollback-${step}`);
      const before = await restoreFacts(fixture.workflowId);
      const faulting = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
        {
          testHooks: {
            afterVersionRestoreStep: (reached) =>
              reached === step
                ? Promise.reject(new Error(`injected-${step}`))
                : Promise.resolve(),
          },
        },
      );
      try {
        await expect(
          faulting.restoreWorkflowVersion(
            await restoreInput(fixture, faulting),
          ),
        ).rejects.toThrow(`injected-${step}`);
      } finally {
        await faulting.close();
      }
      expect(await restoreFacts(fixture.workflowId)).toEqual(before);
      await expect(
        authoring.restoreWorkflowVersion(await restoreInput(fixture)),
      ).resolves.toMatchObject({ revision: before.draft_revision + 1 });
    }
  });

  it('serializes save-first and restore-first races on the workflow and draft rows', async () => {
    const restoreFirstFixture =
      await createRestoreFixture('race-restore-first');
    const restoreLocked = deferred();
    const releaseRestore = deferred();
    const restoreApplication = `restore-first-${randomUUID()}`;
    const saveApplication = `save-after-restore-${randomUUID()}`;
    const restoreFirst = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, restoreApplication),
        max: 1,
      }),
      {
        testHooks: {
          afterVersionRestoreStep: async (step) => {
            if (step !== 'source') return;
            restoreLocked.resolve();
            await releaseRestore.promise;
          },
        },
      },
    );
    const saveAfterRestore = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, saveApplication),
        max: 1,
      }),
    );
    try {
      const tag = await currentRepresentationTag(
        authoring,
        workspaceId,
        restoreFirstFixture.workflowId,
        actorId,
      );
      const restore = restoreFirst.restoreWorkflowVersion(
        await restoreInput(restoreFirstFixture, restoreFirst, tag),
      );
      await restoreLocked.promise;
      const save = saveAfterRestore.saveDraft({
        actorId,
        expectedRevision: 3,
        graphJson: graphWithDuration(3_000),
        workflowId: restoreFirstFixture.workflowId,
        workspaceId,
      });
      const saveExpectation = expect(save).rejects.toBeInstanceOf(
        WorkflowRevisionConflictError,
      );
      await waitForPostgresLock(saveApplication);
      releaseRestore.resolve();
      await expect(restore).resolves.toMatchObject({
        revision: 4,
        graphJson: emptyGraph,
      });
      await saveExpectation;
    } finally {
      releaseRestore.resolve();
      await Promise.all([restoreFirst.close(), saveAfterRestore.close()]);
    }

    const saveFirstFixture = await createRestoreFixture('race-save-first');
    const saveLocked = deferred();
    const releaseSave = deferred();
    const saveFirstApplication = `save-first-${randomUUID()}`;
    const restoreAfterSaveApplication = `restore-after-save-${randomUUID()}`;
    const saveFirst = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, saveFirstApplication),
        max: 1,
      }),
      {
        testHooks: {
          afterSaveCas: async () => {
            saveLocked.resolve();
            await releaseSave.promise;
          },
        },
      },
    );
    const restoreAfterSave = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          restoreAfterSaveApplication,
        ),
        max: 1,
      }),
    );
    try {
      const tag = await currentRepresentationTag(
        authoring,
        workspaceId,
        saveFirstFixture.workflowId,
        actorId,
      );
      const save = saveFirst.saveDraft({
        actorId,
        expectedRevision: 3,
        graphJson: graphWithDuration(3_000),
        workflowId: saveFirstFixture.workflowId,
        workspaceId,
      });
      await saveLocked.promise;
      const restore = restoreAfterSave.restoreWorkflowVersion(
        await restoreInput(saveFirstFixture, restoreAfterSave, tag),
      );
      const restoreExpectation = expect(restore).rejects.toMatchObject({
        currentRevision: 4,
      });
      await waitForPostgresLock(restoreAfterSaveApplication);
      releaseSave.resolve();
      await expect(save).resolves.toMatchObject({ revision: 4 });
      await restoreExpectation;
    } finally {
      releaseSave.resolve();
      await Promise.all([saveFirst.close(), restoreAfterSave.close()]);
    }
  });

  it('restores a fresh tag for an identical graph and preserves retained V1 checksum semantics', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'restore-identical-create',
      name: 'Restore identical',
      workspaceId,
    });
    const version = await authoring.publishWorkflow({
      actorId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        created.workflowId,
        actorId,
      ),
      idempotencyKey: 'restore-identical-publish',
      requestHash: '4'.repeat(64),
      workflowId: created.workflowId,
      workspaceId,
    });
    expect(version.version.checksum).toBe(
      workflowRetainedExecutableChecksum(emptyGraph),
    );
    const tag = await currentRepresentationTag(
      authoring,
      workspaceId,
      created.workflowId,
      actorId,
    );
    await expect(
      authoring.restoreWorkflowVersion({
        actorId,
        representationTag: tag,
        versionId: version.version.id,
        workflowId: created.workflowId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ revision: 2, graphJson: emptyGraph });
  });
});
