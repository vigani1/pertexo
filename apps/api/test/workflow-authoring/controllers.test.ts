import { describe, expect, it, vi } from 'vitest';

import { WorkflowAuthoringController } from '../../src/workflow-authoring/controllers.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
  const createWorkflow = {
    execute: vi.fn().mockResolvedValue({
      body: { workflow: {}, draft: body },
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
    execute: vi.fn().mockResolvedValue({ version: {}, reused: false }),
  };
  return {
    controller: new WorkflowAuthoringController(
      {
        execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      } as never,
      createWorkflow as never,
      getDraft as never,
      saveDraft as never,
      {
        execute: vi.fn().mockResolvedValue({
          valid: true,
          issues: [],
          compatibility: body.compatibility,
        }),
      } as never,
      publishWorkflow as never,
      {
        execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      } as never,
    ),
    createWorkflow,
    getDraft,
    saveDraft,
    publishWorkflow,
  };
}

describe('workflow authoring controller public seam', () => {
  it('parses and delegates a draft read once, then maps the representation ETag', async () => {
    const { controller } = makeController();
    const response = { header: vi.fn() };
    const result = await controller.draft(
      request(),
      { workspaceId, workflowId },
      response,
    );
    expect(result).toEqual(body);
    expect(response.header).toHaveBeenCalledWith('ETag', tag);
  });

  it('requires If-Match before calling the save use case and maps it to 428', async () => {
    const { controller } = makeController();
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
  });

  it('maps the create draft representation ETag to the response', async () => {
    const { controller } = makeController();
    const response = { header: vi.fn() };

    await controller.create(
      request({ 'idempotency-key': 'create-42' }),
      { workspaceId },
      { name: 'Operations' },
      response,
    );

    expect(response.header).toHaveBeenCalledWith('ETag', tag);
  });

  it('parses a complete graph and forwards exactly one save command', async () => {
    const { controller } = makeController();
    const response = { header: vi.fn() };
    await controller.save(
      request({ 'if-match': tag }),
      { workspaceId, workflowId },
      { graph: body.graph },
      response,
    );
    expect(response.header).toHaveBeenCalledWith('ETag', tag);
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

  it('does not call a use case when route or body parsing fails', async () => {
    const { controller } = makeController();
    await expect(
      controller.create(
        request({ 'idempotency-key': 'create-42' }),
        { workspaceId: 'not-a-uuid' },
        { name: 'Operations' },
        { header: vi.fn() },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
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
