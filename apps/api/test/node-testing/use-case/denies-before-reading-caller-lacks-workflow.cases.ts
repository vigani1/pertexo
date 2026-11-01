import { WorkflowNotFoundError } from '@pertexo/core/testing';
import { expect, it, vi } from 'vitest';

import { GetPreviewRunUseCase } from '../../../src/node-testing/use-case.js';
import { authorizeWorkspace } from '../../../src/authorization/index.js';

import { nodeTestingPreview } from '../fixture.js';
import {
  actorId,
  workspaceId,
  workflowId,
  acceptedAt,
  expiresAt,
  actor,
  authorization,
} from './fixture.js';

export function registerDeniesBeforeReadingCallerLacksWorkflow(): void {
  it('denies before reading when the caller lacks workflow update authority', async () => {
    const readPreview = vi.fn().mockResolvedValue(nodeTestingPreview());
    const access = authorization();
    access.findAccess.mockResolvedValue(undefined);
    const useCase = new GetPreviewRunUseCase({ readPreview }, access);

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    expect(readPreview).not.toHaveBeenCalled();
  });

  it('maps a missing scoped preview to hidden not-found', async () => {
    const readPreview = vi.fn().mockResolvedValue(null);
    const useCase = new GetPreviewRunUseCase({ readPreview }, authorization());

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it.each([
    ['null', null, null],
    [
      'inline',
      { kind: 'inline', value: { ok: true } },
      { kind: 'inline', value: { ok: true } },
    ],
    [
      'artifact',
      {
        kind: 'artifact',
        artifactId: '11111111-1111-4111-8111-111111111111',
      },
      {
        kind: 'artifact',
        artifactId: '11111111-1111-4111-8111-111111111111',
      },
    ],
  ] as const)(
    'projects complete %s output exactly',
    async (_name, output, projected) => {
      const startedAt = new Date('2026-08-22T20:01:00.000Z');
      const completedAt = new Date('2026-08-22T20:02:00.000Z');
      const readPreview = vi.fn().mockResolvedValue(
        nodeTestingPreview({
          status: 'succeeded',
          output,
          safeErrorCode: 'provider.completed',
          startedAt,
          completedAt,
        }),
      );
      const useCase = new GetPreviewRunUseCase(
        { readPreview },
        authorization(),
      );

      await expect(
        useCase.execute({
          actor,
          routeWorkspaceId: workspaceId,
          previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        }),
      ).resolves.toEqual({
        preview: {
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          workspaceId,
          workflowId,
          draftRevision: 3,
          nodeId: 'http',
          status: 'succeeded',
          disclosure: {
            sideEffectClass: 'unsafe',
            mayContactProvider: true,
            mayCauseExternalSideEffect: true,
            dryRun: 'not_supported',
          },
          output: projected,
          safeErrorCode: 'provider.completed',
          createdAt: acceptedAt.toISOString(),
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
      });
      expect(readPreview).toHaveBeenCalledWith({
        workspaceId,
        actorUserId: actorId,
        previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });
    },
  );

  it('reuses a frozen matching guard context without another access lookup', async () => {
    const access = authorization();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access,
      disclosure: 'not_found',
    });
    const readPreview = vi.fn().mockResolvedValue(nodeTestingPreview());
    access.findAccess.mockClear();
    const useCase = new GetPreviewRunUseCase({ readPreview }, access);

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        authorizedWorkspace,
        previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ).resolves.toMatchObject({ preview: { status: 'queued' } });
    expect(Object.isFrozen(authorizedWorkspace)).toBe(true);
    expect(access.findAccess).not.toHaveBeenCalled();
  });
}
