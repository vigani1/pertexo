import { describe, expect, it, vi } from 'vitest';
import type { WorkflowAutoPauseDatabase } from '@pertexo/database/api';
import { WorkflowAutoPauseUseCase } from '../../src/workflow-authoring/auto-pause-use-case.js';
import {
  WorkflowAutoPauseController,
  WorkspaceAutoPauseController,
} from '../../src/workflow-authoring/auto-pause-controllers.js';
import { createActorContext } from '../../src/workspaces/index.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId,
  requestId: 'pause-test',
});
const settings = {
  enabled: true,
  thresholdOverride: null,
  workspaceThreshold: 10,
  effectiveThreshold: 10,
  settingsRevision: 1,
  pauseState: 'none' as const,
  pauseRevision: '9007199254740993',
  pausedAt: null,
  pauseReason: null,
  pausedFailures: null,
  pausedLastRunId: null,
};

function fixture(
  role: 'owner' | 'admin' | 'builder' | 'operator' | 'viewer' = 'owner',
) {
  const persistence = {
    readWorkflowSettings: vi.fn().mockResolvedValue(settings),
    updateWorkflowSettings: vi
      .fn()
      .mockResolvedValue({ settings, replayed: false }),
    resumeWorkflow: vi.fn().mockResolvedValue({ settings, replayed: true }),
    readWorkspaceSettings: vi
      .fn()
      .mockResolvedValue({ threshold: 10, revision: 1 }),
    updateWorkspaceSettings: vi.fn().mockResolvedValue({
      settings: { threshold: 12, revision: 2 },
      replayed: false,
    }),
  } satisfies WorkflowAutoPauseDatabase;
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  const controls = new WorkflowAutoPauseUseCase(persistence, authorization);
  return { persistence, authorization, controls };
}

describe('workflow automatic pause application boundary', () => {
  it('preserves bigint revision strings and exact replay responses', async () => {
    const { persistence, controls } = fixture('builder');
    const result = await controls.resume({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      idempotencyKey: 'resume-once',
      request: { expectedPauseRevision: settings.pauseRevision },
    });
    expect(result).toEqual({ settings, replayed: true });
    expect(persistence.resumeWorkflow).toHaveBeenCalledWith({
      workspaceId,
      workflowId,
      actorId,
      idempotencyKey: 'resume-once',
      requestId: 'pause-test',
      expectedPauseRevision: '9007199254740993',
    });
  });

  it.each(['operator', 'viewer'] as const)(
    'does not let %s resume or edit workflow settings',
    async (role) => {
      const { persistence, controls } = fixture(role);
      const input = {
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        idempotencyKey: 'denied',
        request: { expectedPauseRevision: '1' },
      };
      await expect(controls.resume(input)).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      await expect(
        controls.updateWorkflow({
          ...input,
          request: {
            enabled: false,
            thresholdOverride: null,
            expectedSettingsRevision: 1,
          },
        }),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      expect(persistence.resumeWorkflow).not.toHaveBeenCalled();
      expect(persistence.updateWorkflowSettings).not.toHaveBeenCalled();
      expect(await controls.readWorkflow(input)).toEqual(settings);
    },
  );

  it.each(['admin', 'builder', 'operator', 'viewer'] as const)(
    'keeps workspace default owner-only for %s',
    async (role) => {
      const { persistence, controls } = fixture(role);
      await expect(
        controls.updateWorkspace({
          actor,
          routeWorkspaceId: workspaceId,
          idempotencyKey: 'default',
          request: { threshold: 12, expectedRevision: 1 },
        }),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      expect(persistence.updateWorkspaceSettings).not.toHaveBeenCalled();
      expect(
        await controls.readWorkspace({ actor, routeWorkspaceId: workspaceId }),
      ).toEqual({ threshold: 10, revision: 1 });
    },
  );

  it('validates strict request bounds before calling persistence', async () => {
    const { persistence, controls } = fixture();
    for (const request of [
      { enabled: true, thresholdOverride: 2, expectedSettingsRevision: 1 },
      { enabled: true, thresholdOverride: 101, expectedSettingsRevision: 1 },
      {
        enabled: true,
        thresholdOverride: null,
        expectedSettingsRevision: 1,
        warning: true,
      },
    ])
      await expect(
        controls.updateWorkflow({
          actor,
          routeWorkspaceId: workspaceId,
          workflowId,
          idempotencyKey: 'invalid',
          request,
        }),
      ).rejects.toThrow();
    await expect(
      controls.resume({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        idempotencyKey: 'invalid',
        request: { expectedPauseRevision: 9007199254740992 },
      }),
    ).rejects.toThrow();
    expect(persistence.updateWorkflowSettings).not.toHaveBeenCalled();
    expect(persistence.resumeWorkflow).not.toHaveBeenCalled();
  });

  it('requires current active workspace access even for a previously authorized actor', async () => {
    const { controls, authorization, persistence } = fixture();
    authorization.findAccess.mockResolvedValue(undefined);
    await expect(
      controls.readWorkflow({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(persistence.readWorkflowSettings).not.toHaveBeenCalled();
  });
});

describe('automatic pause controller commands', () => {
  it('requires exactly one valid key and does not accept historical numeric pause revisions', async () => {
    const { controls, persistence } = fixture();
    const controller = new WorkflowAutoPauseController(controls);
    const request = {
      headers: { 'idempotency-key': 'one,two' },
      identitySession: {
        userId: actorId,
        sessionId,
        expiresAt: new Date('2027-01-01'),
        clientMetadata: {},
      },
      requestId: 'pause-test',
    };
    await expect(
      controller.resume(
        request,
        { workspaceId, workflowId },
        { expectedPauseRevision: '1' },
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(
      controller.resume(
        { ...request, headers: { 'idempotency-key': 'single' } },
        { workspaceId, workflowId },
        { expectedPauseRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    expect(persistence.resumeWorkflow).not.toHaveBeenCalled();
    const workspace = new WorkspaceAutoPauseController(controls);
    expect(await workspace.read(request, { workspaceId })).toEqual({
      threshold: 10,
      revision: 1,
    });
  });
});
