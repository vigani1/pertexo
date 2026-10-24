import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  WorkflowAutoPauseSettingsRevisionConflictError,
  WorkspaceAutoPauseSettingsRevisionConflictError,
  WorkflowNotFoundError,
} from '../../../../src/testing.js';
import { IdempotencyConflictError } from '../../../../src/platform/idempotency/repository.js';

import {
  identity,
  authoring,
  fold,
  admin,
  controls,
  seed,
  outcome,
  pause,
  failures,
  auditCount,
  pausePeriodCount,
} from './fixture.js';

export function registerReadsDefaultsChangesIndependentlyVersioned(): void {
  it('reads defaults, changes independently versioned settings and makes exact retries/no-ops durable', async () => {
    const scope = await seed();
    const initial = await controls().readWorkflowSettings(scope);
    expect(initial).toMatchObject({
      enabled: true,
      thresholdOverride: null,
      workspaceThreshold: 10,
      effectiveThreshold: 10,
      settingsRevision: 1,
      pauseState: 'none',
      pauseRevision: '1',
      pausedAt: null,
    });
    const command = {
      ...scope,
      enabled: false,
      thresholdOverride: 5,
      expectedSettingsRevision: 1,
      idempotencyKey: randomUUID(),
    };
    const accepted = await controls().updateWorkflowSettings(command);
    expect(accepted.settings).toMatchObject({
      enabled: false,
      effectiveThreshold: 5,
      settingsRevision: 2,
    });
    expect(await controls().updateWorkflowSettings(command)).toEqual({
      ...accepted,
      replayed: true,
    });
    await expect(
      controls().updateWorkflowSettings({ ...command, enabled: true }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      controls().updateWorkflowSettings({
        ...command,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkflowAutoPauseSettingsRevisionConflictError);
    const noop = await controls().updateWorkflowSettings({
      ...command,
      expectedSettingsRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(noop.settings.settingsRevision).toBe(2);
    expect(
      await auditCount(scope, 'workflow.auto_pause_settings_changed'),
    ).toBe(1);
    expect(
      (
        await authoring.getWorkflow(
          scope.workspaceId,
          scope.workflowId,
          scope.actorId,
        )
      )?.lifecycleRevision,
    ).toBe(1);
  });

  it('resumes atomically, discards old pending outcomes, counts new endings and replays the accepted snapshot', async () => {
    const scope = await seed();
    await pause(scope);
    for (let index = 0; index < 3; index++) await outcome(scope);
    const command = {
      ...scope,
      expectedPauseRevision: '2',
      idempotencyKey: randomUUID(),
    };
    const accepted = await controls().resumeWorkflow(command);
    expect(accepted.settings).toMatchObject({
      pauseState: 'none',
      pauseRevision: '3',
      pausedAt: null,
      pausedFailures: null,
      pausedLastRunId: null,
    });
    expect(await failures(scope)).toBe(0);
    expect(await auditCount(scope, 'workflow.triggers_resumed')).toBe(1);
    await fold.foldPending(1000);
    expect(await failures(scope)).toBe(0);
    for (let index = 0; index < 3; index++)
      await outcome(scope, new Date(Date.now() + 1000 + index).toISOString());
    await fold.foldPending(1000);
    expect((await controls().readWorkflowSettings(scope)).pauseRevision).toBe(
      '4',
    );
    expect(await controls().resumeWorkflow(command)).toEqual({
      ...accepted,
      replayed: true,
    });
    expect(await pausePeriodCount(scope)).toBe(1);
    await expect(
      controls().resumeWorkflow({ ...command, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ currentRevision: '4' });
    expect(await auditCount(scope, 'workflow.triggers_resumed')).toBe(1);
  });

  it('keeps a non-paused resume a no-op even with a live streak, and preserves bigint revisions', async () => {
    const scope = await seed();
    await outcome(scope);
    await fold.foldPending(1000);
    await controls().resumeWorkflow({
      ...scope,
      expectedPauseRevision: '1',
      idempotencyKey: randomUUID(),
    });
    expect(await failures(scope)).toBe(1);
    expect(await auditCount(scope, 'workflow.triggers_resumed')).toBe(0);
    expect(await pausePeriodCount(scope)).toBe(0);
    await admin.query(
      `update app.workflows set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
      trigger_pause_reason='consecutive_failures',trigger_pause_failures=3,trigger_pause_last_run_id=gen_random_uuid(),
      trigger_pause_revision=9007199254740993,lifecycle_status='archived'
      where workspace_id=$1 and id=$2`,
      [scope.workspaceId, scope.workflowId],
    );
    expect((await controls().readWorkflowSettings(scope)).pauseRevision).toBe(
      '9007199254740993',
    );
    const result = await controls().resumeWorkflow({
      ...scope,
      expectedPauseRevision: '9007199254740993',
      idempotencyKey: randomUUID(),
    });
    expect(result.settings.pauseRevision).toBe('9007199254740994');
    expect(
      (
        await authoring.getWorkflow(
          scope.workspaceId,
          scope.workflowId,
          scope.actorId,
        )
      )?.lifecycleStatus,
    ).toBe('archived');
  });

  it('uses workspace:manage owner-only while readers and workflow editors have their own scopes', async () => {
    const scope = await seed();
    for (const role of ['admin', 'builder', 'operator', 'viewer'] as const) {
      const actorId = (
        await identity.createUser({
          email: `${randomUUID()}@example.test`,
          displayName: role,
        })
      ).id;
      await admin.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
        [scope.workspaceId, actorId, role],
      );
      const actor = { ...scope, actorId };
      await expect(
        controls().readWorkflowSettings(actor),
      ).resolves.toBeDefined();
      await expect(
        controls().updateWorkspaceSettings({
          ...actor,
          threshold: 4,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      const settings = {
        ...actor,
        enabled: false,
        thresholdOverride: null,
        expectedSettingsRevision: role === 'builder' ? 2 : 1,
        idempotencyKey: randomUUID(),
      };
      if (role === 'admin' || role === 'builder')
        await expect(
          controls().updateWorkflowSettings(settings),
        ).resolves.toBeDefined();
      else
        await expect(
          controls().updateWorkflowSettings(settings),
        ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    }
    const accepted = await controls().updateWorkspaceSettings({
      ...scope,
      threshold: 4,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(accepted.settings).toEqual({ threshold: 4, revision: 2 });
    await expect(
      controls().updateWorkspaceSettings({
        ...scope,
        threshold: 8,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkspaceAutoPauseSettingsRevisionConflictError);
    expect(
      (await controls().readWorkflowSettings(scope)).workspaceThreshold,
    ).toBe(4);
  });
}
