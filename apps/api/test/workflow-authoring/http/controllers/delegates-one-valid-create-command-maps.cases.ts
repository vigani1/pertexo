import { expect, it, vi } from 'vitest';

import {
  workspaceId,
  workflowId,
  actorId,
  sessionId,
  tag,
  body,
  request,
  makeController,
} from './fixture.js';

export function registerDelegatesOneValidCreateCommandMaps(): void {
  it('delegates one valid create command and maps its draft ETag', async () => {
    const { authoring: controller, createWorkflow } = makeController();
    const response = { header: vi.fn() };

    await controller.create(
      request({ 'idempotency-key': 'create-42' }),
      { workspaceId },
      { name: 'Operations' },
      response,
    );

    expect(response.header).toHaveBeenCalledWith('ETag', tag);
    expect(createWorkflow.execute).toHaveBeenCalledExactlyOnceWith({
      actor: {
        actorId,
        kind: 'user',
        requestId: 'request-42',
        sessionId,
        workspaceId,
      },
      requestId: 'request-42',
      routeWorkspaceId: workspaceId,
      request: { name: 'Operations' },
      idempotencyKey: 'create-42',
    });
  });

  it('parses a complete graph and forwards exactly one save command', async () => {
    const { authoring: controller, saveDraft } = makeController();
    const response = { header: vi.fn() };
    await controller.save(
      request({ 'if-match': tag }),
      { workspaceId, workflowId },
      { graph: body.graph },
      response,
    );
    expect(response.header).toHaveBeenCalledWith('ETag', tag);
    expect(saveDraft.execute).toHaveBeenCalledExactlyOnceWith({
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
      representationTag: tag,
      graph: body.graph,
    });
  });

  it('forwards request and trace identifiers on mutating commands', async () => {
    const {
      authoring: controller,
      createWorkflow,
      saveDraft,
      publishWorkflow,
    } = makeController();
    const identifiers = {
      requestId: 'request-forwarded-42',
      traceId: 'trace-forwarded-42',
    } as const;
    const headers = {
      'if-match': tag,
      'idempotency-key': 'publish-forwarded-42',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    };

    await controller.create(
      request({ 'idempotency-key': 'create-forwarded-42' }, identifiers),
      { workspaceId },
      { name: 'Operations' },
      { header: vi.fn() },
    );
    await controller.save(
      request(headers, identifiers),
      { workspaceId, workflowId },
      { graph: body.graph },
      { header: vi.fn() },
    );
    await controller.publish(request(headers, identifiers), {
      workspaceId,
      workflowId,
    });

    expect(createWorkflow.execute).toHaveBeenCalledWith(
      expect.objectContaining(identifiers),
    );
    expect(saveDraft.execute).toHaveBeenCalledWith(
      expect.objectContaining(identifiers),
    );
    expect(publishWorkflow.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        ...identifiers,
        traceparent: headers.traceparent,
      }),
    );
  });

  it('does not call create when its route parsing fails', async () => {
    const { authoring: controller, createWorkflow } = makeController();
    await expect(
      controller.create(
        request({ 'idempotency-key': 'create-42' }),
        { workspaceId: 'not-a-uuid' },
        { name: 'Operations' },
        { header: vi.fn() },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(createWorkflow.execute).not.toHaveBeenCalled();
  });

  it('does not call save when its independently valid route has a malformed body', async () => {
    const { authoring: controller, saveDraft } = makeController();
    await expect(
      controller.save(
        request({ 'if-match': tag }),
        { workspaceId, workflowId },
        { graph: { ...body.graph, unexpected: true } },
        { header: vi.fn() },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(saveDraft.execute).not.toHaveBeenCalled();
  });

  it('rejects route fields outside the workflow collection contract', async () => {
    const { authoring: controller, createWorkflow } = makeController();

    await expect(
      controller.create(
        request({ 'idempotency-key': 'create-42' }),
        { workspaceId, unexpected: 'route-value' },
        { name: 'Operations' },
        { header: vi.fn() },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(createWorkflow.execute).not.toHaveBeenCalled();
  });
}
