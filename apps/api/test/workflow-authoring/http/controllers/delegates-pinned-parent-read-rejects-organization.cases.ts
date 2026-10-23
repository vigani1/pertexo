import { expect, it, vi } from 'vitest';

import {
  workspaceId,
  workflowId,
  actorId,
  guardActorId,
  sessionId,
  tag,
  body,
  workflow,
  request,
  makeController,
} from './fixture.js';

export function registerDelegatesPinnedParentReadRejectsOrganization(): void {
  it('delegates a pinned-parent read and rejects organization filters mixed with it', async () => {
    const { authoring: controller, listWorkflows } = makeController();
    await controller.list(
      request(),
      { workspaceId },
      { pinsWorkflowId: workflowId },
    );
    expect(listWorkflows.execute).toHaveBeenCalledWith(
      expect.objectContaining({ pinsWorkflowId: workflowId }),
    );
    await expect(
      controller.list(
        request(),
        { workspaceId },
        { pinsWorkflowId: workflowId, query: 'ignored' },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(listWorkflows.execute).toHaveBeenCalledOnce();
  });

  it('uses session context without a guard and gives guarded context precedence', async () => {
    const { authoring: controller, createWorkflow } = makeController();
    await controller.create(
      request(
        { 'idempotency-key': 'session-context' },
        { traceId: 'session-trace' },
      ),
      { workspaceId },
      { name: 'Session context' },
      { header: vi.fn() },
    );
    expect(createWorkflow.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped at this nested boundary.
        actor: expect.objectContaining({ actorId, requestId: 'request-42' }),
        requestId: 'request-42',
        traceId: 'session-trace',
      }),
    );
    expect(createWorkflow.execute.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'authorizedWorkspace',
    );

    const authorizedWorkspace = {
      actor: Object.freeze({
        actorId: guardActorId,
        kind: 'user' as const,
        workspaceId,
        sessionId,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
      workspaceId,
      role: 'owner' as const,
      capability: 'workflow:update' as const,
    };
    await controller.create(
      {
        ...request(
          { 'idempotency-key': 'guard-context' },
          { requestId: 'ignored-request', traceId: 'ignored-trace' },
        ),
        authorizedWorkspace,
      },
      { workspaceId },
      { name: 'Guard context' },
      { header: vi.fn() },
    );
    expect(createWorkflow.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: authorizedWorkspace.actor,
        authorizedWorkspace,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
    );
  });

  it('requires If-Match for version restore and returns its fresh draft tag', async () => {
    const { versions: controller, restoreVersion } = makeController();
    const route = {
      workspaceId,
      workflowId,
      versionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    const response = { header: vi.fn() };
    await expect(
      controller.restoreVersion(request(), route, {}, response),
    ).rejects.toMatchObject({ code: 'precondition_required' });
    expect(restoreVersion.execute).not.toHaveBeenCalled();
    expect(
      await controller.restoreVersion(
        request({ 'if-match': tag }),
        route,
        {},
        response,
      ),
    ).toEqual(body);
    expect(restoreVersion.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workflowId,
        versionId: route.versionId,
        representationTag: tag,
        request: {},
      }),
    );
    expect(response.header).toHaveBeenCalledWith('ETag', tag);
  });

  it.each(['archive', 'restore'] as const)(
    'forwards one %s command and requires idempotency',
    async (command) => {
      const { lifecycle: controller, transitionLifecycle } = makeController();
      expect(() =>
        controller[command](
          request(),
          { workspaceId, workflowId },
          { expectedLifecycleRevision: 1 },
        ),
      ).toThrow(expect.objectContaining({ code: 'request.invalid' }));
      expect(transitionLifecycle.execute).not.toHaveBeenCalled();
      await controller[command](
        request({ 'idempotency-key': 'key' }),
        { workspaceId, workflowId },
        { expectedLifecycleRevision: 1 },
      );
      expect(transitionLifecycle.execute).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          command,
          workflowId,
          routeWorkspaceId: workspaceId,
          request: { expectedLifecycleRevision: 1 },
          idempotencyKey: 'key',
        }),
      );
    },
  );

  it('forwards one rename command and requires idempotency before delegation', async () => {
    const { lifecycle: controller, renameWorkflow } = makeController();
    const renameBody = { name: 'Invoices', expectedNameRevision: 1 };
    expect(() =>
      controller.rename(request(), { workspaceId, workflowId }, renameBody),
    ).toThrow(expect.objectContaining({ code: 'request.invalid' }));
    expect(() =>
      controller.rename(
        request({ 'idempotency-key': 'key' }),
        { workspaceId, workflowId: 'not-a-workflow' },
        renameBody,
      ),
    ).toThrow();
    expect(renameWorkflow.execute).not.toHaveBeenCalled();

    await expect(
      controller.rename(
        request({ 'idempotency-key': 'rename-key' }, { traceId: 'trace-7' }),
        { workspaceId, workflowId },
        renameBody,
      ),
    ).resolves.toEqual({ workflow, replayed: false });
    expect(renameWorkflow.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workflowId,
        routeWorkspaceId: workspaceId,
        request: renameBody,
        idempotencyKey: 'rename-key',
      }),
    );
  });

  it('parses and delegates a draft read once, then maps the representation ETag', async () => {
    const { authoring: controller, getDraft } = makeController();
    const response = { header: vi.fn() };
    const result = await controller.draft(
      request(),
      { workspaceId, workflowId },
      response,
    );
    expect(result).toEqual(body);
    expect(getDraft.execute).toHaveBeenCalledExactlyOnceWith({
      actor: {
        actorId,
        kind: 'user',
        requestId: 'request-42',
        sessionId,
        workspaceId,
      },
      requestId: 'request-42',
      routeWorkspaceId: workspaceId,
      workflowId,
    });
    expect(response.header).toHaveBeenCalledWith('ETag', tag);
  });

  it('classifies missing If-Match before calling the save use case', async () => {
    const { authoring: controller, saveDraft } = makeController();
    await expect(
      controller.save(
        request(),
        { workspaceId, workflowId },
        { graph: body.graph },
        { header: vi.fn() },
      ),
    ).rejects.toMatchObject({
      code: 'precondition_required',
      name: 'WorkflowHeaderError',
    });
    expect(saveDraft.execute).not.toHaveBeenCalled();
  });
}
