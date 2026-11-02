import { randomUUID } from 'node:crypto';

import { IdempotencyConflictError } from '@pertexo/database/platform';
import { describe, expect, it } from 'vitest';

import {
  actorId,
  authoring,
  currentRepresentationTag,
  emptyGraph,
  queryAsOwner,
  workspaceId,
} from '../../support/workflow-authoring.js';

const scope = () => ({ workspaceId, actorId });
const tagOf = (workflowId: string) =>
  currentRepresentationTag(authoring, workspaceId, {
    scopedWorkflowId: workflowId,
    scopedActorId: actorId,
  });
const newWorkflow = async (name = 'Receipts') =>
  (
    await authoring.createWorkflow({
      ...scope(),
      name,
      emptyGraph,
      idempotencyKey: randomUUID(),
    })
  ).workflowId;

describe('an exact retry answers with the first result, and a changed request conflicts', () => {
  it('creating a workflow', async () => {
    const input = {
      ...scope(),
      name: 'First',
      emptyGraph,
      idempotencyKey: randomUUID(),
    };
    const first = await authoring.createWorkflow(input);
    // The workflow has moved on since: the retry still names the same one.
    await authoring.renameWorkflow({
      ...scope(),
      workflowId: first.workflowId,
      name: 'Renamed since',
      expectedNameRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const retried = await authoring.createWorkflow(input);
    expect(retried.workflowId).toBe(first.workflowId);
    await expect(
      authoring.createWorkflow({ ...input, name: 'Different' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const made = await queryAsOwner(
      'select id from app.workflows where workspace_id=$1 and id=$2',
      [workspaceId, first.workflowId],
      workspaceId,
    );
    expect(made).toHaveLength(1);
  });

  it('duplicating a workflow', async () => {
    const workflowId = await newWorkflow();
    const input = {
      ...scope(),
      workflowId,
      name: 'A copy',
      source: { kind: 'draft' as const },
      representationTag: await tagOf(workflowId),
      idempotencyKey: randomUUID(),
    };
    const first = await authoring.duplicateWorkflow(input);
    await expect(authoring.duplicateWorkflow(input)).resolves.toEqual(first);
    await expect(
      authoring.duplicateWorkflow({ ...input, name: 'Another copy' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const copies = await queryAsOwner(
      `select id from app.workflows where workspace_id=$1 and name='A copy' and id=$2`,
      [workspaceId, first.workflowId],
      workspaceId,
    );
    expect(copies).toHaveLength(1);
  });

  it('publishing a workflow', async () => {
    const workflowId = await newWorkflow();
    const input = {
      ...scope(),
      workflowId,
      representationTag: await tagOf(workflowId),
      requestHash: 'c'.repeat(64),
      idempotencyKey: randomUUID(),
    };
    const first = await authoring.publishWorkflow(input);
    expect(first).toMatchObject({ replayed: false, reused: false });
    await expect(authoring.publishWorkflow(input)).resolves.toMatchObject({
      replayed: true,
      reused: false,
      version: { id: first.version.id, versionNumber: 1 },
    });
    await expect(
      authoring.publishWorkflow({ ...input, requestHash: 'd'.repeat(64) }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      authoring.listVersions({ ...scope(), workflowId }),
    ).resolves.toMatchObject({ items: [{ id: first.version.id }] });
  });

  it("changing a workflow's auto-pause", async () => {
    const workflowId = await newWorkflow();
    const { settingsRevision } = await authoring.autoPause.readWorkflowSettings(
      { ...scope(), workflowId },
    );
    const input = {
      ...scope(),
      workflowId,
      enabled: true,
      thresholdOverride: 7,
      expectedSettingsRevision: settingsRevision,
      idempotencyKey: randomUUID(),
    };
    const first = await authoring.autoPause.updateWorkflowSettings(input);
    expect(first).toMatchObject({
      replayed: false,
      settings: { thresholdOverride: 7 },
    });
    // Later settings don't change what the first request answered.
    await authoring.autoPause.updateWorkflowSettings({
      ...input,
      thresholdOverride: 8,
      expectedSettingsRevision: first.settings.settingsRevision,
      idempotencyKey: randomUUID(),
    });
    await expect(
      authoring.autoPause.updateWorkflowSettings(input),
    ).resolves.toEqual({ settings: first.settings, replayed: true });
    await expect(
      authoring.autoPause.updateWorkflowSettings({
        ...input,
        thresholdOverride: 9,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("changing the workspace's auto-pause default", async () => {
    const { revision, threshold } =
      await authoring.autoPause.readWorkspaceSettings(scope());
    const chosen = threshold === 40 ? 41 : 40;
    const input = {
      ...scope(),
      threshold: chosen,
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
    };
    const first = await authoring.autoPause.updateWorkspaceSettings(input);
    expect(first.replayed).toBe(false);
    await expect(
      authoring.autoPause.updateWorkspaceSettings(input),
    ).resolves.toEqual({ settings: first.settings, replayed: true });
    await expect(
      authoring.autoPause.updateWorkspaceSettings({
        ...input,
        threshold: chosen + 1,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("resuming a workflow's triggers", async () => {
    const workflowId = await newWorkflow();
    await queryAsOwner(
      `update app.workflows set trigger_pause_state='paused', trigger_paused_at=clock_timestamp(),
         trigger_pause_reason='consecutive_failures', trigger_pause_failures=3,
         trigger_pause_last_run_id=$3, trigger_pause_revision=trigger_pause_revision+1
       where workspace_id=$1 and id=$2 returning 1`,
      [workspaceId, workflowId, randomUUID()],
      workspaceId,
    );
    const { pauseRevision } = await authoring.autoPause.readWorkflowSettings({
      ...scope(),
      workflowId,
    });
    const input = {
      ...scope(),
      workflowId,
      expectedPauseRevision: pauseRevision,
      idempotencyKey: randomUUID(),
    };
    const first = await authoring.autoPause.resumeWorkflow(input);
    expect(first).toMatchObject({
      replayed: false,
      settings: { pauseState: 'none' },
    });
    await expect(authoring.autoPause.resumeWorkflow(input)).resolves.toEqual({
      settings: first.settings,
      replayed: true,
    });
    await expect(
      authoring.autoPause.resumeWorkflow({
        ...input,
        expectedPauseRevision: first.settings.pauseRevision,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
