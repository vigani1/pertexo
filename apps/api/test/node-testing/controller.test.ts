import { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';
import type {
  AcceptedPreviewRun,
  WorkflowDraftRecord,
} from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import { NodeTestingController } from '../../src/node-testing/controller.js';
import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from '../../src/node-testing/use-case.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const connectionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const previewRunId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const acceptedAt = new Date('2026-08-22T20:00:00.000Z');
const expiresAt = new Date('2026-08-22T21:00:00.000Z');

function draft(): WorkflowDraftRecord {
  return {
    workflowId,
    workspaceId,
    revision: 3,
    schemaVersion: 1,
    graphJson: {
      schemaVersion: 1,
      nodes: [
        {
          id: 'http',
          definition: { key: 'http.request', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {
            method: 'POST',
            url: 'https://provider.example.test/resource',
            headers: {},
            timeoutMillis: 1_000,
            maxRedirects: 1,
            maxResponseBytes: 1_024,
            inlineResponseBytes: 512,
          },
          inputMappings: {
            body: { kind: 'run_input', path: '$.body' },
          },
          connectionRefs: { http_headers: connectionId },
        },
      ],
      edges: [],
      settings: {},
    },
    compatibility: {
      compatible: true,
      fingerprint: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.fingerprint,
      issues: [],
    },
    updatedBy: actorId,
    updatedAt: new Date('2026-08-22T19:00:00.000Z'),
  };
}

function controller() {
  const accepted: AcceptedPreviewRun = {
    acceptedAt,
    duplicate: false,
    expiresAt,
    outboxEventId: '11111111-1111-4111-8111-111111111111',
    previewAttemptId: '22222222-2222-4222-8222-222222222222',
    previewRunId,
    status: 'queued',
  };
  const persistence = {
    getDraft: vi.fn().mockResolvedValue(draft()),
    acceptPreview: vi.fn().mockResolvedValue(accepted),
    readPreview: vi.fn().mockResolvedValue({
      id: previewRunId,
      workspaceId,
      workflowId,
      draftRevision: 3,
      nodeId: 'http',
      status: 'queued' as const,
      sideEffectClass: 'unsafe' as const,
      mayContactProvider: true,
      mayCauseExternalSideEffect: true,
      dryRun: 'not_supported' as const,
      output: null,
      safeErrorCode: null,
      createdAt: acceptedAt,
      startedAt: null,
      completedAt: null,
      expiresAt,
    }),
  };
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
  };
  return {
    controller: new NodeTestingController(
      new TestWorkflowNodeUseCase(
        persistence,
        authorization,
        PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
        () => acceptedAt,
      ),
      new GetPreviewRunUseCase(persistence, authorization),
    ),
    persistence,
  };
}

function request(headers: Record<string, string> = {}) {
  return {
    headers,
    requestId: 'request-node-test',
    traceId: 'trace-node-test',
    identitySession: {
      userId: actorId,
      sessionId: '33333333-3333-4333-8333-333333333333',
      expiresAt: new Date('2026-08-23T00:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

const params = { workspaceId, workflowId, nodeId: 'http' };

describe('node testing controller', () => {
  it('returns validation at 200 without requiring or using idempotency', async () => {
    const fixture = controller();
    const response = { status: vi.fn() };
    await expect(
      fixture.controller.test(
        request(),
        params,
        {
          mode: 'validate',
          expectedRevision: 3,
          sampleInput: {
            body: { encoding: 'utf8', value: 'hello' },
          },
        },
        response,
      ),
    ).resolves.toMatchObject({ mode: 'validate', valid: true });
    expect(response.status).not.toHaveBeenCalled();
    expect(fixture.persistence.acceptPreview).not.toHaveBeenCalled();
  });

  it('returns durable execution acceptance at 202', async () => {
    const fixture = controller();
    const response = { status: vi.fn() };
    await expect(
      fixture.controller.test(
        request({ 'Idempotency-Key': 'preview-key' }),
        params,
        {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
        response,
      ),
    ).resolves.toMatchObject({
      mode: 'test_execute',
      preview: { id: previewRunId, status: 'queued' },
    });
    expect(response.status).toHaveBeenCalledWith(202);
    expect(fixture.persistence.acceptPreview).toHaveBeenCalledTimes(1);
  });

  it('maps missing execution idempotency to the stable precondition problem', async () => {
    const fixture = controller();
    await expect(
      fixture.controller.test(
        request(),
        params,
        {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: { kind: 'manual', value: {} },
        },
        { status: vi.fn() },
      ),
    ).rejects.toMatchObject({ name: 'NodeTestIdempotencyRequiredError' });
    expect(fixture.persistence.acceptPreview).not.toHaveBeenCalled();
  });

  it('reads one scoped preview status without using production events', async () => {
    const fixture = controller();
    await expect(
      fixture.controller.status(request(), { workspaceId, previewRunId }),
    ).resolves.toMatchObject({
      preview: { id: previewRunId, status: 'queued', output: null },
    });
    expect(fixture.persistence.readPreview).toHaveBeenCalledWith({
      workspaceId,
      actorUserId: actorId,
      previewRunId,
    });
  });
});
