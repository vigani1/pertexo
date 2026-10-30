import { expect, it, vi } from 'vitest';

import {
  workspaceId,
  workflowId,
  actorId,
  sessionId,
  tag,
  body,
  workflow,
  version,
  request,
  makeController,
} from './fixture.js';

export function registerPassesExactVersionFilterUnderNormal(): void {
  it('passes an exact version filter under the normal workspace read authority', async () => {
    const { versions: controller, listVersions } = makeController();
    await controller.versions(
      request(),
      { workspaceId, workflowId },
      { versionId: version.id },
    );
    expect(listVersions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        workflowId,
        versionId: version.id,
      }),
    );
    listVersions.execute.mockClear();
    await expect(
      controller.versions(
        request(),
        { workspaceId, workflowId },
        {
          versionId: version.id,
          after: 'older-page',
        },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(listVersions.execute).not.toHaveBeenCalled();
  });

  it('uses the exact opt-in origin projection with no-store while preserving default GET', async () => {
    const { authoring: controller, getWorkflow } = makeController();
    const header = vi.fn();
    await expect(
      controller.get(request(), { workspaceId, workflowId }, {}, { header }),
    ).resolves.toEqual({ workflow });
    expect(getWorkflow.execute.mock.lastCall?.[0]).not.toHaveProperty(
      'include',
    );
    expect(header).not.toHaveBeenCalled();
    await controller.get(
      request(),
      { workspaceId, workflowId },
      { include: 'templateOrigin' },
      { header },
    );
    expect(getWorkflow.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ include: 'templateOrigin' }),
    );
    expect(header).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });

  it.each([
    { include: 'origin' },
    { include: ['templateOrigin', 'templateOrigin'] },
    { include: 'templateOrigin', extra: true },
    { extra: true },
  ])(
    'rejects malformed projection query %j before persistence',
    async (query) => {
      const { authoring: controller, getWorkflow } = makeController();
      await expect(
        controller.get(request(), { workspaceId, workflowId }, query, {
          header: vi.fn(),
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(getWorkflow.execute).not.toHaveBeenCalled();
    },
  );

  it('duplicates only a selected saved source and forwards lifetime with a safe destination Location', async () => {
    const { lifecycle: controller, duplicateWorkflow } = makeController();
    const header = vi.fn();
    const payload = { name: 'Copy', source: { kind: 'draft' } };
    await expect(
      controller.duplicate(
        request({ 'if-match': tag, 'idempotency-key': 'copy-once' }),
        { workspaceId, workflowId },
        payload,
        { header },
      ),
    ).resolves.toEqual({ workflowId });
    expect(duplicateWorkflow.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        request: payload,
        representationTag: tag,
        idempotencyKey: 'copy-once',
        signal: expect.any(AbortSignal) as unknown,
      }),
    );
    expect(header).toHaveBeenCalledWith(
      'Location',
      `/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    );
    await controller.duplicate(
      request({ 'idempotency-key': 'version-copy' }),
      { workspaceId, workflowId },
      { name: 'Version', source: { kind: 'version', versionId: version.id } },
      { header },
    );
    expect(duplicateWorkflow.execute.mock.calls[1]?.[0]).not.toHaveProperty(
      'representationTag',
    );
  });

  it('rejects absent/malformed draft tags and client graph payloads before duplication', async () => {
    const { lifecycle: controller, duplicateWorkflow } = makeController();
    const payload = { name: 'Copy', source: { kind: 'draft' } };
    for (const headers of [
      { 'idempotency-key': 'copy' },
      { 'idempotency-key': 'copy', 'if-match': '*' },
    ]) {
      await expect(
        controller.duplicate(
          request(headers),
          { workspaceId, workflowId },
          payload,
          { header: vi.fn() },
        ),
      ).rejects.toMatchObject({ name: 'WorkflowHeaderError' });
    }
    await expect(
      controller.duplicate(
        request({ 'idempotency-key': 'copy', 'if-match': tag }),
        { workspaceId, workflowId },
        { ...payload, graph: body.graph },
        { header: vi.fn() },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(duplicateWorkflow.execute).not.toHaveBeenCalled();
  });

  it('returns the checked snapshot tag and forwards the request signal for validate and publish', async () => {
    const {
      authoring: controller,
      validateDraft,
      publishWorkflow,
    } = makeController();
    const header = vi.fn();
    await expect(
      controller.validate(request(), { workspaceId, workflowId }, { header }),
    ).resolves.toEqual({
      valid: true,
      currentPublication: null,
      issues: [],
      compatibility: body.compatibility,
    });
    expect(header).toHaveBeenCalledWith('ETag', tag);
    expect(validateDraft.execute).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId }),
    );
    expect(validateDraft.execute.mock.calls[0]?.[0]).toHaveProperty(
      'signal',
      expect.any(AbortSignal),
    );
    await controller.publish(
      request({ 'if-match': tag, 'idempotency-key': 'original-key' }),
      { workspaceId, workflowId },
    );
    expect(publishWorkflow.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        representationTag: tag,
        idempotencyKey: 'original-key',
      }),
    );
    expect(publishWorkflow.execute.mock.calls[0]?.[0]).toHaveProperty(
      'signal',
      expect.any(AbortSignal),
    );
  });

  it('delegates bounded list input and rejects empty or oversized cursors before delegation', async () => {
    const { authoring: controller, listWorkflows } = makeController();
    await expect(
      controller.list(
        request(),
        { workspaceId },
        {
          limit: '100',
          order: 'updated_desc',
        },
      ),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(listWorkflows.execute).toHaveBeenCalledExactlyOnceWith({
      actor: {
        actorId,
        kind: 'user',
        requestId: 'request-42',
        sessionId,
        workspaceId,
      },
      requestId: 'request-42',
      routeWorkspaceId: workspaceId,
      limit: 100,
      order: 'updated_desc',
    });

    for (const after of ['', 'x'.repeat(513)]) {
      await expect(
        controller.list(request(), { workspaceId }, { after }),
      ).rejects.toMatchObject({ name: 'ZodError' });
    }
    expect(listWorkflows.execute).toHaveBeenCalledOnce();
  });
}
