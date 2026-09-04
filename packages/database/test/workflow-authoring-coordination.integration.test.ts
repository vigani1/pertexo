import { describe, expect, it } from 'vitest';

import {
  BASELINE_COMPATIBILITY_EXPECTATION,
  Pool,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  actorId,
  apiPool,
  apiUrl,
  authoring,
  createHash,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  deferred,
  emptyGraph,
  migrationUrl,
  otherWorkflowId,
  parseDatabaseConfig,
  baselineEmptyDefinitionCatalog,
  queryAsOwner,
  workflowId,
  workspaceId,
  waitForPostgresLock,
  withApplicationName,
} from './support/workflow-authoring.integration.support.js';

describe('workflow authoring coordination', () => {
  it('holds the durable compatibility pointer lock through publication commit', async () => {
    const pointerApplication = `workflow-pointer-${workflowId}`;
    const releaseLocked = deferred();
    const releasePublication = deferred();
    const checksum = `wf:v2:sha256:${'b'.repeat(64)}` as const;
    const executableJson = {
      schemaVersion: 2,
      compatibilityReleaseEpoch: 1,
      compatibilityReleaseFingerprint:
        BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
    };
    const lockingAuthoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        compatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
        definitionCatalog: baselineEmptyDefinitionCatalog,
        executableCompiler: () => ({
          checksum,
          executableSchemaVersion: 2,
          executableJson,
          compatibilityReleaseEpoch: 1,
          compatibilityReleaseFingerprint:
            BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
        }),
        testHooks: {
          afterCompatibilityReleaseLock: async () => {
            releaseLocked.resolve();
            await releasePublication.promise;
          },
        },
      },
    );
    const pointerPool = new Pool({
      connectionString: withApplicationName(migrationUrl, pointerApplication),
      max: 1,
    });
    const owner = await pointerPool.connect();
    try {
      const created = await lockingAuthoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: 'create-compatibility-lock-proof',
        name: 'Compatibility lock proof',
        workspaceId,
      });
      const representationTag = await currentRepresentationTag(
        lockingAuthoring,
        workspaceId,
        created.workflowId,
        actorId,
        baselineEmptyDefinitionCatalog,
      );
      const publication = lockingAuthoring.publishWorkflow({
        actorId,
        representationTag,
        idempotencyKey: 'publish-compatibility-lock-proof',
        requestHash: 'a'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      await releaseLocked.promise;

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      let pointerUpdateCompleted = false;
      const pointerUpdate = owner
        .query(
          `update app.node_compatibility_current
              set activated_at = activated_at
            where singleton`,
        )
        .then(() => {
          pointerUpdateCompleted = true;
        });
      await waitForPostgresLock(pointerApplication);
      expect(pointerUpdateCompleted).toBe(false);

      releasePublication.resolve();
      await expect(publication).resolves.toMatchObject({
        version: { checksum },
      });
      await pointerUpdate;
      await owner.query('commit');
    } catch (error: unknown) {
      releasePublication.resolve();
      await owner.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      owner.release();
      await pointerPool.end();
      await lockingAuthoring.close();
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
    ).resolves.toMatchObject({ workflowId });
  });

  it('denies saves after the workflow is archived', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-archived-save-proof',
      name: 'Archived save proof',
      workspaceId,
    });
    const client = await apiPool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        "update app.workflows set lifecycle_status = 'archived' where id = $1",
        [created.workflowId],
      );
      await client.query('commit');
    } finally {
      client.release();
    }

    await expect(
      authoring.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 1_000 } },
        workflowId: created.workflowId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    const facts = await queryAsOwner<{ audits: string; revision: number }>(
      `select draft.revision,
              (select count(*) from app.audit_events audit
               where audit.target_id = draft.workflow_id
                 and audit.action = 'workflow.draft_saved')::text as audits
       from app.workflow_drafts draft where draft.workflow_id = $1`,
      [created.workflowId],
      workspaceId,
    );
    expect(facts[0]).toEqual({ audits: '0', revision: 1 });
  });

  it('lists immutable versions with a bounded deterministic cursor', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-version-page-proof',
      name: 'Version page proof',
      workspaceId,
    });
    for (const [index, duration] of [undefined, 1_000, 2_000].entries()) {
      if (duration !== undefined) {
        await authoring.saveDraft({
          actorId,
          expectedRevision: index,
          graphJson: {
            ...emptyGraph,
            settings: { maxRunDurationMs: duration },
          },
          workflowId: created.workflowId,
          workspaceId,
        });
      }
      await authoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          created.workflowId,
          actorId,
        ),
        idempotencyKey: `publish-version-page-${String(index + 1)}`,
        requestHash: createHash('sha256')
          .update(`version-page-${String(index + 1)}`)
          .digest('hex'),
        workflowId: created.workflowId,
        workspaceId,
      });
    }

    const first = await authoring.listVersions({
      actorId,
      limit: 2,
      workflowId: created.workflowId,
      workspaceId,
    });
    expect(first.items.map((version) => version.versionNumber)).toEqual([3, 2]);
    expect(first.nextCursor).toEqual({ beforeVersionNumber: 2 });
    if (first.nextCursor === undefined)
      throw new Error('Expected version cursor');
    await expect(
      authoring.listVersions({
        actorId,
        beforeVersionNumber: first.nextCursor.beforeVersionNumber,
        limit: 2,
        workflowId: created.workflowId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ items: [{ versionNumber: 1 }] });
    await expect(
      authoring.listVersions({
        actorId,
        workflowId: otherWorkflowId,
        workspaceId,
      }),
    ).rejects.toThrow('Workflow is not visible');
  });

  it('serializes both save-first and publish-first lock orders without graph skew', async () => {
    const saveFirstPublisherApplication = `workflow-save-first-${workflowId}`;
    const saveFirstDraft = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-save-first-race',
      name: 'Save first race',
      workspaceId,
    });
    const saveLocked = deferred();
    const releaseSave = deferred();
    const saveFirstTag = await currentRepresentationTag(
      authoring,
      workspaceId,
      saveFirstDraft.workflowId,
      actorId,
    );
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
    const saveFirstPublisher = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          saveFirstPublisherApplication,
        ),
        max: 1,
      }),
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
      const publish = saveFirstPublisher.publishWorkflow({
        actorId,
        representationTag: saveFirstTag,
        idempotencyKey: 'publish-save-first-race',
        requestHash: '5'.repeat(64),
        workflowId: saveFirstDraft.workflowId,
        workspaceId,
      });
      const publishExpectation = expect(publish).rejects.toMatchObject({
        currentRevision: 2,
      });
      await waitForPostgresLock(saveFirstPublisherApplication);
      releaseSave.resolve();
      await expect(save).resolves.toMatchObject({ revision: 2 });
      await publishExpectation;
    } finally {
      await Promise.all([
        saveFirstDatabase.close(),
        saveFirstPublisher.close(),
      ]);
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
    const publishFirstTag = await currentRepresentationTag(
      authoring,
      workspaceId,
      publishFirstDraft.workflowId,
      actorId,
    );
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
    const publishFirstSaverApplication = `workflow-publish-first-${workflowId}`;
    const publishFirstSaver = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          publishFirstSaverApplication,
        ),
        max: 1,
      }),
    );
    try {
      const publish = publishFirstDatabase.publishWorkflow({
        actorId,
        representationTag: publishFirstTag,
        idempotencyKey: 'publish-publish-first-race',
        requestHash: '7'.repeat(64),
        workflowId: publishFirstDraft.workflowId,
        workspaceId,
      });
      await publishLocked.promise;
      const save = publishFirstSaver.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: {
          ...emptyGraph,
          settings: { maxRunDurationMs: 4_000 },
        },
        workflowId: publishFirstDraft.workflowId,
        workspaceId,
      });
      const saveExpectation = expect(save).resolves.toMatchObject({
        revision: 2,
      });
      await waitForPostgresLock(publishFirstSaverApplication);
      releasePublish.resolve();
      await expect(publish).resolves.toMatchObject({
        version: { graphJson: emptyGraph },
      });
      await saveExpectation;
    } finally {
      await Promise.all([
        publishFirstDatabase.close(),
        publishFirstSaver.close(),
      ]);
    }
  });
});
