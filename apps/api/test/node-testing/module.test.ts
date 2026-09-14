import { Module } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';
import { describe, expect, it, vi } from 'vitest';

import {
  DoubleSubmitCsrfPolicy,
  OpaqueSessionService,
} from '../../src/identity/index.js';
import { NodeTestingController } from '../../src/node-testing/controller.js';
import { NodeTestingModule } from '../../src/node-testing/module.js';
import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from '../../src/node-testing/use-case.js';
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
      provide: OpaqueSessionService,
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
  exports: [RequestContextStore, OpaqueSessionService, DoubleSubmitCsrfPolicy],
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
    release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    expressionEvaluator: { evaluate },
  };
}

describe('node testing Nest module', () => {
  it('owns preview routes and providers behind declared capabilities', () => {
    const dynamic = NodeTestingModule.register(
      {
        authorization: { findAccess: () => Promise.resolve(undefined) },
        persistence: {
          getDraft: () => Promise.resolve(null),
          acceptPreview: () => Promise.reject(new Error('not exercised')),
          resolvePreviewReplay: () => Promise.resolve(null),
          readPreview: () => Promise.resolve(null),
        },
        release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
        expressionEvaluator: {
          evaluate: () => Promise.reject(new Error('not exercised')),
        },
      },
      { module: FakeIdentityModule },
    );
    const providers = dynamic.providers ?? [];
    expect(dynamic.controllers).toEqual([NodeTestingController]);
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provide: TestWorkflowNodeUseCase }),
        expect.objectContaining({ provide: GetPreviewRunUseCase }),
      ]),
    );
  });

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
                  policyVersion: 1,
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
