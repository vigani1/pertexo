import { createHash, randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

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

/**
 * Rows as they sit in a database today, spelled out rather than made by the code:
 * a change to a command's scope, its request's shape or how it's hashed would make
 * an honest retry of one of these conflict, or run the command a second time.
 */
describe('a receipt written before the authoring pass still replays', () => {
  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  async function writtenEarlier(
    operation: string,
    {
      scope: commandScope,
      request,
      resourceId,
      result,
    }: Readonly<{
      scope: string;
      request: string;
      resourceId: string;
      result: object;
    }>,
  ) {
    const idempotencyKey = randomUUID();
    await queryAsOwner(
      `insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref)
       values($1,$2,$3,$4,$5,$6,'completed',$7,$8::jsonb) returning 1`,
      [
        randomUUID(),
        workspaceId,
        operation,
        commandScope,
        sha256(idempotencyKey),
        sha256(request),
        resourceId,
        JSON.stringify(result),
      ],
      workspaceId,
    );
    return idempotencyKey;
  }

  let published: Readonly<{ workflowId: string; versionId: string }>;

  beforeAll(async () => {
    const workflowId = await newWorkflow('Published earlier');
    const { version } = await authoring.publishWorkflow({
      ...scope(),
      workflowId,
      representationTag: await tagOf(workflowId),
      requestHash: 'e'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    published = { workflowId, versionId: version.id };
  });

  it('creating a workflow', async () => {
    const { workflowId } = published;
    const idempotencyKey = await writtenEarlier('workflow.create', {
      scope: actorId,
      // Keys in sorted order, as the stored digest was taken.
      request: `{"graph":{"edges":[],"nodes":[],"settings":{}},"name":"Created earlier","requestedWorkflowId":null}`,
      resourceId: workflowId,
      result: { workflowId },
    });
    await expect(
      authoring.createWorkflow({
        ...scope(),
        name: 'Created earlier',
        emptyGraph,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ workflowId });
  });

  it('duplicating a workflow', async () => {
    const { workflowId } = published;
    const copy = await newWorkflow('Copied earlier');
    const representationTag = await tagOf(workflowId);
    const idempotencyKey = await writtenEarlier('workflow.duplicate', {
      scope: `${actorId}:${workflowId}`,
      request: `{"name":"Copied earlier","representationTag":${JSON.stringify(representationTag)},"source":{"kind":"draft"}}`,
      resourceId: copy,
      result: { workflowId: copy },
    });
    await expect(
      authoring.duplicateWorkflow({
        ...scope(),
        workflowId,
        name: 'Copied earlier',
        source: { kind: 'draft' },
        representationTag,
        idempotencyKey,
      }),
    ).resolves.toEqual({ workflowId: copy });
  });

  it('publishing a workflow', async () => {
    const { workflowId, versionId } = published;
    const requestHash = 'f'.repeat(64);
    const idempotencyKey = await writtenEarlier('workflow.publish', {
      scope: `${actorId}:${workflowId}`,
      // The caller's digest, stored as the hash of it as a JSON string.
      request: `"${requestHash}"`,
      resourceId: workflowId,
      result: { versionId, reused: true },
    });
    await expect(
      authoring.publishWorkflow({
        ...scope(),
        workflowId,
        representationTag: await tagOf(workflowId),
        requestHash,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({
      replayed: true,
      reused: true,
      version: { id: versionId },
    });
  });

  it('renaming, from before receipts carried the webhook flag', async () => {
    const { workflowId } = published;
    const earlier = '2026-01-02T03:04:05.000Z';
    const idempotencyKey = await writtenEarlier('workflow.rename', {
      scope: `${actorId}:${workflowId}`,
      request: `{"expectedNameRevision":1,"name":"Renamed earlier"}`,
      resourceId: workflowId,
      result: {
        workflow: {
          id: workflowId,
          workspaceId,
          name: 'Renamed earlier',
          nameRevision: 2,
          lifecycleStatus: 'active',
          lifecycleRevision: 1,
          activationStatus: 'inactive',
          publishedVersionId: null,
          createdBy: actorId,
          createdAt: earlier,
          updatedAt: earlier,
        },
      },
    });
    await expect(
      authoring.renameWorkflow({
        ...scope(),
        workflowId,
        name: 'Renamed earlier',
        expectedNameRevision: 1,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({
      workflow: {
        name: 'Renamed earlier',
        webhookSetupRequired: false,
        createdAt: new Date(earlier),
      },
      replayed: true,
    });
  });

  const WORKFLOW_SETTINGS = {
    enabled: true,
    thresholdOverride: 7,
    workspaceThreshold: 10,
    effectiveThreshold: 7,
    settingsRevision: 2,
    pauseState: 'none',
    pauseRevision: '1',
    pausedAt: null,
    pauseReason: null,
    pausedFailures: null,
    pausedLastRunId: null,
  };

  it("changing a workflow's auto-pause", async () => {
    const { workflowId } = published;
    const idempotencyKey = await writtenEarlier('workflow.autopause.settings', {
      scope: `${actorId}:${workflowId}`,
      request: `{"enabled":true,"expectedSettingsRevision":1,"thresholdOverride":7}`,
      resourceId: workflowId,
      result: WORKFLOW_SETTINGS,
    });
    await expect(
      authoring.autoPause.updateWorkflowSettings({
        ...scope(),
        workflowId,
        enabled: true,
        thresholdOverride: 7,
        expectedSettingsRevision: 1,
        idempotencyKey,
      }),
    ).resolves.toEqual({ settings: WORKFLOW_SETTINGS, replayed: true });
  });

  it("resuming a workflow's triggers", async () => {
    const { workflowId } = published;
    const idempotencyKey = await writtenEarlier('workflow.autopause.resume', {
      scope: `${actorId}:${workflowId}`,
      request: `{"expectedPauseRevision":"3"}`,
      resourceId: workflowId,
      result: WORKFLOW_SETTINGS,
    });
    await expect(
      authoring.autoPause.resumeWorkflow({
        ...scope(),
        workflowId,
        expectedPauseRevision: '3',
        idempotencyKey,
      }),
    ).resolves.toEqual({ settings: WORKFLOW_SETTINGS, replayed: true });
  });

  it("changing the workspace's auto-pause default", async () => {
    const settings = { threshold: 12, revision: 5 };
    const idempotencyKey = await writtenEarlier(
      'workspace.autopause.settings',
      {
        scope: `${actorId}:${workspaceId}`,
        request: `{"expectedRevision":4,"threshold":12}`,
        resourceId: workspaceId,
        result: settings,
      },
    );
    await expect(
      authoring.autoPause.updateWorkspaceSettings({
        ...scope(),
        threshold: 12,
        expectedRevision: 4,
        idempotencyKey,
      }),
    ).resolves.toEqual({ settings, replayed: true });
  });
});
