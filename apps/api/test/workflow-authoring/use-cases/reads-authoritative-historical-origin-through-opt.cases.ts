import { expect, it, vi } from 'vitest';
import { GetWorkflowUseCase } from '../../../src/workflow-authoring/use-cases.js';
import { createDraftRepresentationTag } from '../../../src/workflow-authoring/http/etag.js';
import { authorizeWorkspace } from '../../../src/authorization/index.js';

import { WorkflowNotFoundError } from '@pertexo/core/testing';
import { TransitionWorkflowLifecycleUseCase } from '../../../src/workflow-authoring/commands/lifecycle.js';

import { RestoreWorkflowVersionUseCase } from '../../../src/workflow-authoring/commands/restore-version.js';

import {
  actorId,
  workspaceId,
  workflowId,
  fingerprint,
  graph,
  actor,
  workflow,
  version,
  authorization,
  persistence,
  templateOrigin,
} from './fixture.js';

export function registerReadsAuthoritativeHistoricalOriginThroughOpt(): void {
  it.each([null, templateOrigin])(
    'reads authoritative historical origin only through the opt-in persistence snapshot (%j)',
    async (origin) => {
      const getWorkflowWithTemplateOrigin = vi.fn().mockResolvedValue({
        workflow: workflow(),
        templateOrigin: origin,
      });
      const store = persistence({ getWorkflowWithTemplateOrigin });
      const useCase = new GetWorkflowUseCase(store, authorization());
      const ordinary = await useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
      });
      expect(ordinary).not.toHaveProperty('templateOrigin');
      expect(getWorkflowWithTemplateOrigin).not.toHaveBeenCalled();
      vi.mocked(store.getWorkflow).mockClear();
      const projected = await useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        include: 'templateOrigin',
      });
      expect(projected).toEqual({ ...ordinary, templateOrigin: origin });
      expect(getWorkflowWithTemplateOrigin).toHaveBeenCalledWith(
        workspaceId,
        workflowId,
        actorId,
      );
      expect(store.getWorkflow).not.toHaveBeenCalled();
    },
  );

  it('fails unavailable rather than inventing origin-null on an unsupported reader', async () => {
    const store = persistence();
    await expect(
      new GetWorkflowUseCase(store, authorization()).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        include: 'templateOrigin',
      }),
    ).rejects.toMatchObject({ code: 'workflow.template_origin_unavailable' });
    expect(store.getWorkflow).not.toHaveBeenCalled();
  });

  it('denies lost membership before reading origin or revealing unsupported projection', async () => {
    const getWorkflowWithTemplateOrigin = vi.fn();
    const store = persistence({ getWorkflowWithTemplateOrigin });
    await expect(
      new GetWorkflowUseCase(
        store,
        authorization({ membershipStatus: 'suspended' }),
      ).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        include: 'templateOrigin',
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(getWorkflowWithTemplateOrigin).not.toHaveBeenCalled();
    expect(store.getWorkflow).not.toHaveBeenCalled();
  });

  it('fails closed on an absent workflow and malformed or missing origin evidence', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ workflow: workflow() })
      .mockResolvedValueOnce({
        workflow: workflow(),
        templateOrigin: { ...templateOrigin, privateSetup: 'must not escape' },
      });
    const useCase = new GetWorkflowUseCase(
      persistence({ getWorkflowWithTemplateOrigin: read }),
      authorization(),
    );
    const input = {
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      include: 'templateOrigin',
    } as const;
    await expect(useCase.execute(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    await expect(useCase.execute(input)).rejects.toMatchObject({
      name: 'ZodError',
    });
    await expect(useCase.execute(input)).rejects.toMatchObject({
      name: 'ZodError',
    });
  });

  it('reads one workflow without relying on list pagination', async () => {
    const store = persistence();
    const result = await new GetWorkflowUseCase(store, authorization()).execute(
      {
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
      },
    );
    expect(result.workflow.name).toBe('Operations');
    expect(store.getWorkflow).toHaveBeenCalledWith(
      workspaceId,
      workflowId,
      actorId,
    );
  });

  it('fails closed when an individually requested workflow is not visible', async () => {
    const store = persistence({ getWorkflow: vi.fn().mockResolvedValue(null) });

    await expect(
      new GetWorkflowUseCase(store, authorization()).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it('restores a version through one atomic command preserving the original tag', async () => {
    const store = persistence();
    const representationTag = createDraftRepresentationTag({
      workflowId,
      revision: 1,
      graph,
      compatibilityFingerprint: fingerprint,
    });
    const result = await new RestoreWorkflowVersionUseCase(
      store,
      authorization(),
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      versionId: version().id,
      representationTag,
      request: {},
    });
    expect(store.restoreWorkflowVersion).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      versionId: version().id,
      actorId,
      representationTag,
      requestId: actor.requestId,
    });
    expect(result.body.revision).toBe(2);
    expect(result.representationTag).not.toBe(representationTag);
    expect(store.getDraft).not.toHaveBeenCalled();
    expect(store.publishWorkflow).not.toHaveBeenCalled();
  });

  it('forwards preauthorization and trace context for restore and lifecycle commands', async () => {
    const store = persistence();
    const access = authorization();
    const tracedActor = { ...actor, traceId: 'trace-42' };
    const authorizedWorkspace = await authorizeWorkspace({
      actor: tracedActor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access,
      disclosure: 'not_found',
    });
    const representationTag = createDraftRepresentationTag({
      workflowId,
      revision: 1,
      graph,
      compatibilityFingerprint: fingerprint,
    });

    await new RestoreWorkflowVersionUseCase(store, access).execute({
      actor: tracedActor,
      authorizedWorkspace,
      routeWorkspaceId: workspaceId,
      workflowId,
      versionId: version().id,
      representationTag,
      request: {},
    });
    const lifecycleAuthorization = await authorizeWorkspace({
      actor: tracedActor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:publish',
      access,
      disclosure: 'not_found',
    });
    await new TransitionWorkflowLifecycleUseCase(store, access).execute({
      actor: tracedActor,
      authorizedWorkspace: lifecycleAuthorization,
      routeWorkspaceId: workspaceId,
      workflowId,
      command: 'archive',
      request: { expectedLifecycleRevision: 1 },
      idempotencyKey: 'lifecycle-trace',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    });

    expect(store.restoreWorkflowVersion).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'trace-42' }),
    );
    expect(store.transitionWorkflowLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-42',
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      }),
    );
  });
}
