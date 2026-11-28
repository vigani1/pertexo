import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { WorkflowNotFoundError } from '../../../src/authoring/workflows/workflow-authoring.errors.js';
import {
  currentRepresentationTag,
  emptyGraph,
} from '../../support/workflow-authoring/drafts.js';
import {
  admin,
  afterAllFixture2,
  auditCount,
  authoring,
  beforeAllFixture1,
  controls,
  fold,
  identity,
  outcome,
  seed,
} from './auto-pause-controls.fixture.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

describe('manual workflow trigger pause', () => {
  it('requires a publication and authority to publish', async () => {
    const scope = await seed();
    const command = {
      ...scope,
      expectedPauseRevision: '1',
      idempotencyKey: randomUUID(),
    };
    await expect(controls().pauseWorkflow(command)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    const published = await publication(scope);
    const viewer = await identity.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Viewer',
    });
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')",
      [scope.workspaceId, viewer.id],
    );
    await expect(
      controls().pauseWorkflow({
        ...command,
        ...published,
        actorId: viewer.id,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      controls().readWorkflowSettings(published),
    ).resolves.toMatchObject({ pauseState: 'none', pauseRevision: '1' });
  });

  it('preserves a manual cause through automatic outcomes, archive, restore and exact retry', async () => {
    const scope = await publication(await seed());
    await controls().updateWorkflowSettings({
      ...scope,
      enabled: true,
      thresholdOverride: 3,
      expectedSettingsRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const command = {
      ...scope,
      expectedPauseRevision: '1',
      idempotencyKey: randomUUID(),
    };
    const first = await controls().pauseWorkflow(command);
    expect(first).toMatchObject({
      replayed: false,
      settings: {
        pauseState: 'paused',
        pauseReason: 'manual',
        pausedBy: { id: scope.actorId, displayName: 'Owner' },
        pausedFailures: null,
        pauseRevision: '2',
        settingsRevision: 2,
      },
    });
    expect(first.settings.pausedAt).toBeTypeOf('string');
    await expect(
      controls().pauseWorkflow({ ...command, expectedPauseRevision: '2' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      controls().pauseWorkflow({ ...command, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ currentRevision: '2' });
    await expect(
      controls().pauseWorkflow({
        ...command,
        expectedPauseRevision: '2',
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toEqual(first);
    for (let index = 0; index < 3; index++) await outcome(scope);
    expect(await fold.foldPending(1000)).toEqual([]);
    expect(await controls().readWorkflowSettings(scope)).toEqual(
      first.settings,
    );
    expect(await auditCount(scope, 'workflow.triggers_paused')).toBe(1);

    for (const [intent, expectedLifecycleRevision] of [
      ['archive', 1],
      ['restore', 2],
    ] as const) {
      await authoring.transitionWorkflowLifecycle({
        ...scope,
        command: intent,
        expectedLifecycleRevision,
        idempotencyKey: randomUUID(),
      });
      expect(await controls().readWorkflowSettings(scope)).toEqual(
        first.settings,
      );
      expect(
        await authoring.getWorkflow(
          scope.workspaceId,
          scope.workflowId,
          scope.actorId,
        ),
      ).toMatchObject({
        lifecycleStatus: intent === 'archive' ? 'archived' : 'active',
      });
    }
    const resume = {
      ...scope,
      expectedPauseRevision: '2',
      idempotencyKey: randomUUID(),
    };
    const resumed = await controls().resumeWorkflow(resume);
    expect(resumed.settings).toMatchObject({
      pauseState: 'none',
      pauseReason: null,
      pauseRevision: '3',
    });
    expect(resumed.settings).not.toHaveProperty('pausedBy');
    await expect(controls().pauseWorkflow(command)).resolves.toEqual({
      ...first,
      replayed: true,
    });
    await expect(
      controls().resumeWorkflow({
        ...resume,
        expectedPauseRevision: '3',
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toEqual(resumed);
    expect(await auditCount(scope, 'workflow.triggers_resumed')).toBe(1);
    const { rows } = await admin.query(
      `select paused_by, pause_revision::text, to_char(paused_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as paused_at
       from app.workflow_trigger_pause_periods where workspace_id=$1 and workflow_id=$2`,
      [scope.workspaceId, scope.workflowId],
    );
    expect(rows).toEqual([
      {
        paused_by: scope.actorId,
        pause_revision: '2',
        paused_at: first.settings.pausedAt,
      },
    ]);
  });
});

async function publication({
  workspaceId,
  actorId,
}: Awaited<ReturnType<typeof seed>>) {
  const created = await authoring.createWorkflow({
    workspaceId,
    actorId,
    emptyGraph,
    name: 'Published workflow',
    idempotencyKey: randomUUID(),
  });
  const workflowId = created.workflowId;
  await authoring.publishWorkflow({
    workspaceId,
    actorId,
    workflowId,
    idempotencyKey: randomUUID(),
    representationTag: await currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: workflowId,
      scopedActorId: actorId,
    }),
    requestHash: 'a'.repeat(64),
  });
  return { workspaceId, actorId, workflowId };
}
