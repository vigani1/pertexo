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

function request(headers: Record<string, string> = {}) {
  return {
    requestId: 'request-42',
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
  return {
    controller: new WorkflowAuthoringController(
      {
        execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      } as never,
      {
        execute: vi.fn().mockResolvedValue({ workflow: {}, draft: body }),
      } as never,
      {
        execute: vi.fn().mockResolvedValue({ body, representationTag: tag }),
      } as never,
      {
        execute: vi.fn().mockResolvedValue({ body, representationTag: tag }),
      } as never,
      {
        execute: vi.fn().mockResolvedValue({
          valid: true,
          issues: [],
          compatibility: body.compatibility,
        }),
      } as never,
      {
        execute: vi.fn().mockResolvedValue({ version: {}, reused: false }),
      } as never,
      {
        execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      } as never,
    ),
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
    ).rejects.toMatchObject({ code: 'request.precondition_required' });
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

  it('does not call a use case when route or body parsing fails', async () => {
    const { controller } = makeController();
    await expect(
      controller.create(
        request({ 'idempotency-key': 'create-42' }),
        { workspaceId: 'not-a-uuid' },
        { name: 'Operations' },
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
  });
});
