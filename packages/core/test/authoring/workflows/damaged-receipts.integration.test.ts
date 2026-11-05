import { isStoredDataError } from '../../../src/shared/stored-values.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actorId,
  authoring,
  currentRepresentationTag,
  emptyGraph,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../support/workflow-authoring.js';
import { afterEachFixture1, command, database } from './portability/fixture.js';

afterEach(afterEachFixture1);

// The fixture sets these in a hook, so read them inside a test.
const scope = () => ({ workspaceId, actorId });

/** What a replay finds when a stored result no longer reads. */
async function damage(operation: string) {
  const rows = await queryAsOwner(
    `update app.idempotency_records set result_ref='{"damaged":true}'::jsonb
     where workspace_id=$1 and operation=$2 returning id`,
    [workspaceId, operation],
    workspaceId,
  );
  expect(rows.length).toBeGreaterThan(0);
}

const newWorkflow = async () =>
  (
    await authoring.createWorkflow({
      ...scope(),
      name: 'Receipts',
      emptyGraph,
      idempotencyKey: randomUUID(),
    })
  ).workflowId;

/** The first attempt lands, then its exact retry meets a damaged receipt. */
async function retryOverDamage<T>(operation: string, run: () => Promise<T>) {
  await run();
  await damage(operation);
  return run();
}

describe('a damaged receipt is reported as stored-data corruption', () => {
  it('creating a workflow', async () => {
    const idempotencyKey = randomUUID();
    await expect(
      retryOverDamage('workflow.create', () =>
        authoring.createWorkflow({
          ...scope(),
          name: 'Receipts',
          emptyGraph,
          idempotencyKey,
        }),
      ),
    ).rejects.toSatisfy(isStoredDataError);
  });

  it('duplicating a workflow', async () => {
    const workflowId = await newWorkflow();
    const idempotencyKey = randomUUID();
    const representationTag = await currentRepresentationTag(
      authoring,
      workspaceId,
      { scopedWorkflowId: workflowId, scopedActorId: actorId },
    );
    await expect(
      retryOverDamage('workflow.duplicate', () =>
        authoring.duplicateWorkflow({
          ...scope(),
          workflowId,
          name: 'A copy',
          source: { kind: 'draft' },
          representationTag,
          idempotencyKey,
        }),
      ),
    ).rejects.toSatisfy(isStoredDataError);
  });

  it('publishing a workflow', async () => {
    const workflowId = await newWorkflow();
    const idempotencyKey = randomUUID();
    const representationTag = await currentRepresentationTag(
      authoring,
      workspaceId,
      { scopedWorkflowId: workflowId, scopedActorId: actorId },
    );
    await expect(
      retryOverDamage('workflow.publish', () =>
        authoring.publishWorkflow({
          ...scope(),
          workflowId,
          representationTag,
          requestHash: 'a'.repeat(64),
          idempotencyKey,
        }),
      ),
    ).rejects.toSatisfy(isStoredDataError);
  });

  it('renaming and archiving a workflow', async () => {
    const workflowId = await newWorkflow();
    const renameKey = randomUUID();
    await expect(
      retryOverDamage('workflow.rename', () =>
        authoring.renameWorkflow({
          ...scope(),
          workflowId,
          name: 'Renamed',
          expectedNameRevision: 1,
          idempotencyKey: renameKey,
        }),
      ),
    ).rejects.toSatisfy(isStoredDataError);
    const archiveKey = randomUUID();
    await expect(
      retryOverDamage('workflow.archive', () =>
        authoring.transitionWorkflowLifecycle({
          ...scope(),
          workflowId,
          command: 'archive',
          expectedLifecycleRevision: 1,
          idempotencyKey: archiveKey,
        }),
      ),
    ).rejects.toSatisfy(isStoredDataError);
  });

  it('changing auto-pause settings', async () => {
    const workflowId = await newWorkflow();
    const { settingsRevision } = await authoring.autoPause.readWorkflowSettings(
      { ...scope(), workflowId },
    );
    const workflowKey = randomUUID();
    await expect(
      retryOverDamage('workflow.autopause.settings', () =>
        authoring.autoPause.updateWorkflowSettings({
          ...scope(),
          workflowId,
          enabled: true,
          thresholdOverride: 7,
          expectedSettingsRevision: settingsRevision,
          idempotencyKey: workflowKey,
        }),
      ),
    ).rejects.toSatisfy(isStoredDataError);
    const { revision } =
      await authoring.autoPause.readWorkspaceSettings(scope());
    const workspaceKey = randomUUID();
    await expect(
      retryOverDamage('workspace.autopause.settings', () =>
        authoring.autoPause.updateWorkspaceSettings({
          ...scope(),
          threshold: 9,
          expectedRevision: revision,
          idempotencyKey: workspaceKey,
        }),
      ),
    ).rejects.toSatisfy(isStoredDataError);
  });

  it('importing a workflow', async () => {
    const store = database();
    const input = command();
    await expect(
      retryOverDamage('workflow.import', () => store.importWorkflow(input)),
    ).rejects.toSatisfy(isStoredDataError);
  });
  it('tags a receipt that names a different workflow as stored corruption', async () => {
    const workflowId = await newWorkflow();
    const input = {
      ...scope(),
      workflowId,
      name: 'Renamed safely',
      expectedNameRevision: 1,
      idempotencyKey: randomUUID(),
    };
    await authoring.renameWorkflow(input);
    await queryAsOwner(
      `update app.idempotency_records set result_ref=jsonb_set(result_ref,'{workflow,id}',to_jsonb($3::text)) where workspace_id=$1 and resource_id=$2 and operation='workflow.rename'`,
      [workspaceId, workflowId, randomUUID()],
      workspaceId,
    );
    await expect(authoring.renameWorkflow(input)).rejects.toSatisfy(
      isStoredDataError,
    );
  });

  it('changing concurrency settings', async () => {
    const workflowId = await newWorkflow();
    const actor = { ...scope(), workflowId };
    const current = await authoring.concurrency.readSettings(actor);
    const input = {
      ...actor,
      limit: null,
      expectedRevision: current.revision,
      idempotencyKey: randomUUID(),
    };
    await expect(
      retryOverDamage('workflow.concurrency', () =>
        authoring.concurrency.updateSettings(input),
      ),
    ).rejects.toSatisfy(isStoredDataError);
  });

  it('changing the error workflow', async () => {
    const workflowId = await newWorkflow();
    const actor = { ...scope(), workflowId };
    const current = await authoring.errorWorkflow.readSettings(actor);
    const input = {
      ...actor,
      targetWorkflowId: null,
      expectedRevision: current.revision,
      idempotencyKey: randomUUID(),
    };
    await expect(
      retryOverDamage('workflow.error.policy', () =>
        authoring.errorWorkflow.updateSettings(input),
      ),
    ).rejects.toSatisfy(isStoredDataError);
  });

  it('creating a discussion', async () => {
    const workflowId = await newWorkflow();
    const input = {
      ...scope(),
      workflowId,
      body: 'Keep this discussion',
      stepId: null,
      mentionUserIds: [],
      idempotencyKey: randomUUID(),
    };
    await expect(
      retryOverDamage('workflow.comment.created', () =>
        authoring.collaboration.create(input),
      ),
    ).rejects.toSatisfy(isStoredDataError);
  });
});
