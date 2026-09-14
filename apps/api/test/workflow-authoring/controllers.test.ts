import { describe, expect, it, vi } from 'vitest';

import { WorkflowAuthoringController } from '../../src/workflow-authoring/controllers.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const guardActorId = '99999999-9999-4999-8999-999999999999';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tag = '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';
const body = {
  workflowId,
  revision: 1,
  schemaVersion: 1,
  graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
  compatibility: {
    compatible: true,
    fingerprint:
      'wf-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    issues: [],
  },
  updatedAt: '2026-08-20T12:00:00.000Z',
};
const workflow = {
  id: workflowId,
  workspaceId,
  name: 'Operations',
  lifecycleStatus: 'active' as const,
  lifecycleRevision: 1,
  activationStatus: 'inactive' as const,
  publishedVersionId: null,
  createdAt: '2026-08-20T12:00:00.000Z',
  updatedAt: '2026-08-20T12:00:00.000Z',
};
const version = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  workflowId,
  versionNumber: 1,
  schemaVersion: 1 as const,
  graph: body.graph,
  checksum:
    'wf:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  publishedAt: '2026-08-20T12:00:00.000Z',
};

function request(
  headers: Record<string, string> = {},
  identifiers: Readonly<{ requestId?: string; traceId?: string }> = {},
) {
  return {
    requestId: identifiers.requestId ?? 'request-42',
    ...(identifiers.traceId === undefined
      ? {}
      : { traceId: identifiers.traceId }),
    headers,
    identitySession: {
      userId: actorId,
      sessionId,
      expiresAt: new Date('2026-08-20T20:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

function makeController() {
  const listWorkflows = {
    execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  const restoreVersion = {
    execute: vi.fn().mockResolvedValue({ body, representationTag: tag }),
  };
  const transitionLifecycle = {
    execute: vi.fn().mockResolvedValue({ workflow, replayed: false }),
  };
  const createWorkflow = {
    execute: vi.fn().mockResolvedValue({
      body: { workflow, draft: body },
      representationTag: tag,
    }),
  };
  const saveDraft = {
    execute: vi.fn().mockResolvedValue({ body, representationTag: tag }),
  };
  const getDraft = {
    execute: vi.fn().mockResolvedValue({ body, representationTag: tag }),
  };
  const publishWorkflow = {
    execute: vi.fn().mockResolvedValue({ version, reused: false }),
  };
  const validateDraft = {
    execute: vi.fn().mockResolvedValue({
      valid: true,
      issues: [],
      compatibility: body.compatibility,
    }),
  };
  const listVersions = {
    execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  return {
    controller: new WorkflowAuthoringController(
      listWorkflows as never,
      createWorkflow as never,
      getDraft as never,
      saveDraft as never,
      validateDraft as never,
      publishWorkflow as never,
      listVersions as never,
      transitionLifecycle as never,
      restoreVersion as never,
    ),
    transitionLifecycle,
    restoreVersion,
    createWorkflow,
    getDraft,
    saveDraft,
    publishWorkflow,
    listWorkflows,
    listVersions,
    validateDraft,
  };
}

describe('workflow authoring controller public seam', () => {
  it('delegates bounded list input and rejects empty or oversized cursors before delegation', async () => {
    const { controller, listWorkflows } = makeController();
    await expect(
      controller.list(request(), { workspaceId }, { limit: '100' }),
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
    });

    for (const after of ['', 'x'.repeat(513)]) {
      await expect(
        controller.list(request(), { workspaceId }, { after }),
      ).rejects.toMatchObject({ name: 'ZodError' });
    }
    expect(listWorkflows.execute).toHaveBeenCalledOnce();
  });

  it('uses session context without a guard and gives guarded context precedence', async () => {
    const { controller, createWorkflow } = makeController();
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

  it('maps an invalid session actor to request.invalid before delegation', async () => {
    const { controller, createWorkflow } = makeController();
    const invalid = {
      ...request({ 'idempotency-key': 'invalid-actor' }),
      identitySession: {
        ...request().identitySession,
        userId: 'not-a-uuid',
      },
    };
    await expect(
      controller.create(
        invalid,
        { workspaceId },
        { name: 'Invalid actor' },
        { header: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    expect(createWorkflow.execute).not.toHaveBeenCalled();
  });
  it('requires If-Match for version restore and returns its fresh draft tag', async () => {
    const { controller, restoreVersion } = makeController();
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
      const { controller, transitionLifecycle } = makeController();
      expect(() =>
        controller[command](
          request(),
          { workspaceId, workflowId },
          { expectedLifecycleRevision: 1 },
        ),
      ).toThrow('Idempotency-Key must contain exactly one valid value');
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
  it('parses and delegates a draft read once, then maps the representation ETag', async () => {
    const { controller, getDraft } = makeController();
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
    const { controller, saveDraft } = makeController();
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

  it('delegates one valid create command and maps its draft ETag', async () => {
    const { controller, createWorkflow } = makeController();
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
    const { controller, saveDraft } = makeController();
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
    const { controller, createWorkflow, saveDraft, publishWorkflow } =
      makeController();
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
    const { controller, createWorkflow } = makeController();
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
    const { controller, saveDraft } = makeController();
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
    const { controller, createWorkflow } = makeController();

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
});
