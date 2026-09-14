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
  finishControlledScenario,
  finishTransactionClient,
  migrationUrl,
  otherWorkflowId,
  parseDatabaseConfig,
  baselineEmptyDefinitionCatalog,
  queryAsOwner,
  randomUUID,
  saveCurrentDraft,
  workflowId,
  workspaceId,
  waitForPostgresLock,
  waitForOperationEntry,
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
    let rollbackFailure: unknown;
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
      await waitForOperationEntry(
        releaseLocked.promise,
        publication,
        'compatibility-locked publication',
      );

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
      try {
        await owner.query('rollback');
      } catch (rollbackError: unknown) {
        rollbackFailure = rollbackError;
      }
      throw error;
    } finally {
      owner.release(
        rollbackFailure === undefined
          ? undefined
          : new Error('Compatibility pointer proof rollback failed', {
              cause: rollbackFailure,
            }),
      );
      await pointerPool.end();
      await lockingAuthoring.close();
    }
  });

  it('allows exactly one racing compare-and-swap save', async () => {
    const results = await Promise.allSettled([
      saveCurrentDraft(authoring, {
        actorId,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 1_000 } },
        workflowId,
        workspaceId,
      }),
      saveCurrentDraft(authoring, {
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
    let transactionOpen = false;
    let primaryError: unknown;
    try {
      await client.query('begin');
      transactionOpen = true;
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        "update app.workflows set lifecycle_status = 'archived' where id = $1",
        [created.workflowId],
      );
      await client.query('commit');
      transactionOpen = false;
    } catch (error: unknown) {
      primaryError = error;
    }
    await finishTransactionClient(client, {
      label: 'Archived workflow fixture update',
      primaryError,
      transactionOpen,
    });

    await expect(
      saveCurrentDraft(authoring, {
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

  it.each(['save', 'publish', 'lifecycle'] as const)(
    'holds actor authority stable until the %s command commits',
    async (command) => {
      const created = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: `create-authority-${command}-${randomUUID()}`,
        name: `Authority ${command}`,
        workspaceId,
      });
      const entered = deferred();
      const releaseOperation = deferred();
      const authorityApplication = `wa-${command}-${randomUUID()}`;
      const controlled = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
        {
          testHooks: {
            ...(command === 'save'
              ? {
                  afterSaveCas: async () => {
                    entered.resolve();
                    await releaseOperation.promise;
                  },
                }
              : {}),
            ...(command === 'publish'
              ? {
                  afterPublishDraftLock: async () => {
                    entered.resolve();
                    await releaseOperation.promise;
                  },
                }
              : {}),
            ...(command === 'lifecycle'
              ? {
                  afterLifecycleStep: async (step) => {
                    if (step !== 'workflow') return;
                    entered.resolve();
                    await releaseOperation.promise;
                  },
                }
              : {}),
          },
        },
      );
      const authorityPool = new Pool({
        connectionString: withApplicationName(
          migrationUrl,
          authorityApplication,
        ),
        max: 1,
      });
      const authority = await authorityPool.connect();
      let operation: Promise<unknown> | undefined;
      let suspension: Promise<unknown> | undefined;
      let authorityOpen = false;
      let primaryError: unknown;
      let cleanupFailures: unknown[] = [];
      try {
        operation =
          command === 'save'
            ? saveCurrentDraft(controlled, {
                actorId,
                expectedRevision: 1,
                graphJson: {
                  ...emptyGraph,
                  settings: { maxRunDurationMs: 5_000 },
                },
                workflowId: created.workflowId,
                workspaceId,
              })
            : command === 'publish'
              ? controlled.publishWorkflow({
                  actorId,
                  representationTag: await currentRepresentationTag(
                    controlled,
                    workspaceId,
                    created.workflowId,
                    actorId,
                  ),
                  idempotencyKey: `publish-authority-${created.workflowId}`,
                  requestHash: '9'.repeat(64),
                  workflowId: created.workflowId,
                  workspaceId,
                })
              : controlled.transitionWorkflowLifecycle({
                  actorId,
                  command: 'archive',
                  expectedLifecycleRevision: 1,
                  idempotencyKey: `archive-authority-${created.workflowId}`,
                  workflowId: created.workflowId,
                  workspaceId,
                });
        await waitForOperationEntry(
          entered.promise,
          operation,
          `${command} authority command`,
        );

        await authority.query('begin');
        authorityOpen = true;
        await authority.query('set local role pertexo_owner');
        await authority.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        suspension = authority.query(
          `update app.workspace_memberships set status='suspended'
            where workspace_id=$1 and user_id=$2`,
          [workspaceId, actorId],
        );
        void suspension.catch(() => undefined);
        await waitForPostgresLock(authorityApplication);
        releaseOperation.resolve();
        await expect(operation).resolves.toBeDefined();
        await expect(suspension).resolves.toMatchObject({ rowCount: 1 });
        await authority.query('rollback');
        authorityOpen = false;

        const facts = await queryAsOwner<{
          audits: string;
          lifecycle_revision: number;
          published_version_id: string | null;
          revision: number;
        }>(
          `select draft.revision, workflow.lifecycle_revision,
                  workflow.published_version_id,
                  (select count(*) from app.audit_events audit
                    where audit.target_id=workflow.id
                      and audit.action = $2)::text audits
             from app.workflows workflow
             join app.workflow_drafts draft on draft.workflow_id=workflow.id
            where workflow.id=$1`,
          [
            created.workflowId,
            command === 'save'
              ? 'workflow.draft_saved'
              : command === 'publish'
                ? 'workflow.published'
                : 'workflow.archived',
          ],
          workspaceId,
        );
        expect(facts[0]).toMatchObject({
          audits: '1',
          lifecycle_revision: command === 'lifecycle' ? 2 : 1,
          revision: command === 'save' ? 2 : 1,
        });
        if (command === 'publish')
          expect(facts[0]?.published_version_id).toEqual(expect.any(String));
        else expect(facts[0]?.published_version_id).toBeNull();
      } catch (error: unknown) {
        primaryError = error;
      } finally {
        releaseOperation.resolve();
        if (authorityOpen)
          await authority.query('rollback').catch(() => undefined);
        await Promise.allSettled(
          [operation, suspension].filter(
            (value): value is Promise<unknown> => value !== undefined,
          ),
        );
        authority.release();
        const cleanup = await Promise.allSettled([
          authorityPool.end(),
          controlled.close(),
        ]);
        cleanupFailures = cleanup.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
      }
      if (primaryError !== undefined) {
        if (cleanupFailures.length > 0)
          throw new AggregateError(
            [primaryError, ...cleanupFailures],
            `${command} authority proof and cleanup failed`,
          );
        if (primaryError instanceof Error) throw primaryError;
        throw new Error(`${command} authority proof failed`, {
          cause: primaryError,
        });
      }
      if (cleanupFailures.length > 0)
        throw new AggregateError(
          cleanupFailures,
          `${command} authority proof cleanup failed`,
        );
    },
    15_000,
  );

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
        await saveCurrentDraft(authoring, {
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
    let save: Promise<unknown> | undefined;
    let publish: Promise<unknown> | undefined;
    let primaryError: unknown;
    try {
      save = saveCurrentDraft(saveFirstDatabase, {
        actorId,
        expectedRevision: 1,
        graphJson: {
          ...emptyGraph,
          settings: { maxRunDurationMs: 3_000 },
        },
        workflowId: saveFirstDraft.workflowId,
        workspaceId,
      });
      await waitForOperationEntry(saveLocked.promise, save, 'save-first save');
      publish = saveFirstPublisher.publishWorkflow({
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
    } catch (error: unknown) {
      primaryError = error;
    }
    await finishControlledScenario({
      close: [
        () => saveFirstDatabase.close(),
        () => saveFirstPublisher.close(),
      ],
      label: 'save-first authoring race',
      operations: [save, publish],
      primaryError,
      release: releaseSave.resolve,
    });

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
    let publishFirstOperation: Promise<unknown> | undefined;
    let saveAfterPublish: Promise<unknown> | undefined;
    primaryError = undefined;
    try {
      publishFirstOperation = publishFirstDatabase.publishWorkflow({
        actorId,
        representationTag: publishFirstTag,
        idempotencyKey: 'publish-publish-first-race',
        requestHash: '7'.repeat(64),
        workflowId: publishFirstDraft.workflowId,
        workspaceId,
      });
      await waitForOperationEntry(
        publishLocked.promise,
        publishFirstOperation,
        'publish-first publication',
      );
      saveAfterPublish = saveCurrentDraft(publishFirstSaver, {
        actorId,
        expectedRevision: 1,
        graphJson: {
          ...emptyGraph,
          settings: { maxRunDurationMs: 4_000 },
        },
        workflowId: publishFirstDraft.workflowId,
        workspaceId,
      });
      const saveExpectation = expect(saveAfterPublish).resolves.toMatchObject({
        revision: 2,
      });
      await waitForPostgresLock(publishFirstSaverApplication);
      releasePublish.resolve();
      await expect(publishFirstOperation).resolves.toMatchObject({
        version: { graphJson: emptyGraph },
      });
      await saveExpectation;
    } catch (error: unknown) {
      primaryError = error;
    }
    await finishControlledScenario({
      close: [
        () => publishFirstDatabase.close(),
        () => publishFirstSaver.close(),
      ],
      label: 'publish-first authoring race',
      operations: [publishFirstOperation, saveAfterPublish],
      primaryError,
      release: releasePublish.resolve,
    });
  });
});
