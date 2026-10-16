import { nodeTestingSamples } from './fixture.js';
import { Module } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { describe, expect, it, vi } from 'vitest';

import { DoubleSubmitCsrfPolicy } from '../../src/identity/index.js';
import { SESSION_AUTHORITY } from '../../src/workspaces/index.js';
import { NodeTestingModule } from '../../src/node-testing/module.js';
import { TestWorkflowNodeUseCase } from '../../src/node-testing/use-case.js';
import { RequestContextStore } from '../../src/platform/http/index.js';
import {
  httpNodeTestingGraph,
  nodeTestingAcceptedAt,
  nodeTestingDraft,
  nodeTestingExpiresAt,
  nodeTestingIds,
} from './fixture.js';

// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class FakeIdentityModule {}
Module({
  providers: [
    {
      provide: RequestContextStore,
      useValue: { setActor: () => undefined, setWorkspace: () => undefined },
    },
    {
      provide: SESSION_AUTHORITY,
      useValue: {
        authenticate: () =>
          Promise.resolve({
            userId: nodeTestingIds.actorId,
            sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            expiresAt: new Date('2030-01-01T00:00:00.000Z'),
            clientMetadata: {},
          }),
      },
    },
    {
      provide: DoubleSubmitCsrfPolicy,
      useValue: { assertMutationAllowed: () => undefined },
    },
  ],
  exports: [RequestContextStore, SESSION_AUTHORITY, DoubleSubmitCsrfPolicy],
})(FakeIdentityModule);

function dependencies() {
  const evaluate = vi.fn().mockResolvedValue({
    kind: 'value',
    value: { encoding: 'utf8', value: 'evaluated' },
    canonicalBytes: 39,
  });
  return {
    authorization: {
      findAccess: vi.fn().mockResolvedValue({
        actorId: nodeTestingIds.actorId,
        workspaceId: nodeTestingIds.workspaceId,
        role: 'builder' as const,
        membershipStatus: 'active' as const,
        workspaceStatus: 'active' as const,
      }),
    },
    persistence: {
      stepSamples: nodeTestingSamples(),
      getDraft: vi.fn().mockResolvedValue(nodeTestingDraft()),
      acceptPreview: vi.fn().mockResolvedValue({
        acceptedAt: nodeTestingAcceptedAt,
        duplicate: false,
        expiresAt: nodeTestingExpiresAt,
        outboxEventId: '11111111-1111-4111-8111-111111111111',
        previewAttemptId: '22222222-2222-4222-8222-222222222222',
        previewRunId: nodeTestingIds.previewRunId,
        status: 'queued' as const,
      }),
      resolvePreviewReplay: vi.fn().mockResolvedValue(null),
      readPreview: vi.fn().mockResolvedValue(null),
    },
    release: PLATFORM_NODE_CATALOG,
    expressionEvaluator: { evaluate },
  };
}

describe('node testing Nest module', () => {
  it('forwards the registered evaluator through the resolved use case', async () => {
    const supplied = dependencies();
    supplied.persistence.getDraft.mockResolvedValueOnce(
      nodeTestingDraft({
        graphJson: {
          ...httpNodeTestingGraph(),
          nodes: [
            {
              ...httpNodeTestingGraph().nodes[0],
              inputMappings: {
                body: {
                  kind: 'expression',
                  language: 'jsonata',
                  expression: 'runInput.body',
                },
              },
            },
          ],
        },
      }),
    );
    const testing = await Test.createTestingModule({
      imports: [
        NodeTestingModule.register(supplied, { module: FakeIdentityModule }),
      ],
    }).compile();
    try {
      const useCase = testing.get(TestWorkflowNodeUseCase);
      await expect(
        useCase.execute({
          actor: {
            actorId: nodeTestingIds.actorId,
            kind: 'user',
            workspaceId: nodeTestingIds.workspaceId,
            sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            requestId: 'module-evaluator',
          },
          routeWorkspaceId: nodeTestingIds.workspaceId,
          workflowId: nodeTestingIds.workflowId,
          nodeId: 'http',
          request: {
            mode: 'validate',
            expectedRevision: 3,
            sampleInput: { body: 'source' },
          },
        }),
      ).resolves.toMatchObject({ valid: true });
      expect(supplied.expressionEvaluator.evaluate).toHaveBeenCalledOnce();
    } finally {
      await testing.close();
    }
  });

  it('serves sample reads and exact-key writes through Nest and Fastify', async () => {
    const supplied = dependencies();
    const sampleId = '11111111-1111-4111-8111-111111111111';
    const put = vi
      .spyOn(supplied.persistence.stepSamples, 'put')
      .mockResolvedValue({
        sampleId,
        removed: false,
        replayed: false,
      });
    vi.spyOn(supplied.persistence.stepSamples, 'remove').mockResolvedValue({
      sampleId,
      removed: true,
      replayed: false,
    });
    const testing = await Test.createTestingModule({
      imports: [
        NodeTestingModule.register(supplied, { module: FakeIdentityModule }),
      ],
    }).compile();
    const adapter = new FastifyAdapter();
    const application = testing.createNestApplication(adapter);
    try {
      await application.init();
      const server = adapter.getInstance();
      const root = `/v1/workspaces/${nodeTestingIds.workspaceId}/workflows/${nodeTestingIds.workflowId}/draft`;
      const headers = {
        cookie: 'pertexo_session=session-token',
        'content-type': 'application/json',
        'idempotency-key': 'sample-http-proof',
      };
      const list = await server.inject({
        method: 'GET',
        url: `${root}/samples`,
        headers,
      });
      expect(list.statusCode).toBe(200);
      expect(list.headers['cache-control']).toBe('private, no-store');
      const read = await server.inject({
        method: 'GET',
        url: `${root}/nodes/http/sample`,
        headers,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        sample: null,
        output: null,
        draftRevision: 3,
      });
      const saved = await server.inject({
        method: 'PUT',
        url: `${root}/nodes/http/sample`,
        headers,
        payload: {
          expectedDraftRevision: 3,
          expectedSampleId: null,
          source: { kind: 'json', value: { amount: 42 } },
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(put).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: 'http',
          expectedSampleId: null,
          idempotencyKey: 'sample-http-proof',
          source: { kind: 'json', value: { amount: 42 } },
        }),
      );
      const removed = await server.inject({
        method: 'DELETE',
        url: `${root}/nodes/http/sample`,
        headers,
        payload: { expectedDraftRevision: 3, expectedSampleId: sampleId },
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ removed: true, sampleId });
    } finally {
      await application.close();
    }
  });

  it('serves validation at 200 and durable acceptance at 202 through Nest and Fastify', async () => {
    const supplied = dependencies();
    const testing = await Test.createTestingModule({
      imports: [
        NodeTestingModule.register(supplied, { module: FakeIdentityModule }),
      ],
    }).compile();
    const adapter = new FastifyAdapter();
    const application = testing.createNestApplication(adapter);
    try {
      await application.init();
      const server = adapter.getInstance();
      const url = `/v1/workspaces/${nodeTestingIds.workspaceId}/workflows/${nodeTestingIds.workflowId}/draft/nodes/http/test`;
      const headers = {
        cookie: 'pertexo_session=session-token',
        'content-type': 'application/json',
      };
      const validation = await server.inject({
        method: 'POST',
        url,
        headers,
        payload: {
          mode: 'validate',
          expectedRevision: 3,
          sampleInput: {
            body: { encoding: 'utf8', value: 'hello' },
          },
        },
      });
      const execution = await server.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'idempotency-key': 'module-preview' },
        payload: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      });

      expect(validation.statusCode).toBe(200);
      expect(execution.statusCode).toBe(202);
      expect(supplied.persistence.acceptPreview).toHaveBeenCalledOnce();
    } finally {
      await application.close();
    }
  });
});
