import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';
import {
  WorkflowNotFoundError,
  PreviewIdempotencyConflictError,
} from '@pertexo/core/testing';
import {
  TestWorkflowNodeUseCase,
  GetPreviewRunUseCase,
} from '../../src/node-testing/use-case.js';
import { authorizeWorkspace } from '../../src/authorization/index.js';
import {
  workspaceId,
  acceptedAt,
  expiresAt,
  actor,
  graph,
  graphWithConfig,
  draft,
  accepted,
  persistence,
  authorization,
  requestInput,
  actorId,
  workflowId,
  emailGraph,
} from './use-case/fixture.js';
import { NodeTestInvalidError } from '../../src/node-testing/errors.js';
import { nodeTestingPreview } from './fixture.js';

describe('node test application use case', () => {
  it('uses pinned output without evaluating mappings or authorizing credentials, while setup validation stays real', async () => {
    const store = persistence({
      getDraft: vi
        .fn()
        .mockResolvedValue(draft({ graphJson: graphWithConfig({}) })),
    });
    const sampleId = randomUUID();
    vi.spyOn(store.stepSamples, 'get').mockResolvedValue({
      sample: {
        id: sampleId,
        nodeId: 'http',
        binding: 'server-checked',
        state: 'pinned',
        source: { kind: 'json' },
        createdAt: acceptedAt,
        expiresAt,
      },
      output: { kind: 'inline', value: { example: true } },
      draftRevision: 3,
    });
    vi.spyOn(store, 'acceptPreview').mockResolvedValue({
      ...accepted(),
      status: 'succeeded',
      outboxEventId: null,
      previewAttemptId: null,
      pinnedSampleId: sampleId,
      pinnedOutput: { kind: 'inline', value: { example: true } },
      completedAt: acceptedAt,
    });
    const access = authorization();
    const evaluate = vi
      .fn()
      .mockRejectedValue(new Error('Unused mapping must not execute'));
    const useCase = new TestWorkflowNodeUseCase(
      store,
      access,
      () => acceptedAt,
      { evaluate },
    );
    const response = await useCase.execute({
      ...requestInput(),
      idempotencyKey: randomUUID(),
      request: {
        mode: 'test_execute',
        expectedRevision: 3,
        expectedSampleId: sampleId,
        acknowledgeSideEffects: true,
        input: { kind: 'manual', value: {} },
      },
    });
    expect(response).toMatchObject({
      mode: 'test_execute',
      preview: {
        status: 'succeeded',
        pinnedSampleId: sampleId,
        startedAt: null,
        output: { kind: 'inline', value: { example: true } },
        disclosure: {
          mayContactProvider: false,
          mayCauseExternalSideEffect: false,
        },
      },
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(access.findAccess).toHaveBeenCalledTimes(1);
    await expect(
      useCase.execute({
        ...requestInput(),
        request: { mode: 'validate', expectedRevision: 3, sampleInput: {} },
      }),
    ).resolves.toMatchObject({ valid: false });
    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: randomUUID(),
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          expectedSampleId: null,
          acknowledgeSideEffects: true,
          input: { kind: 'manual', value: {} },
        },
      }),
    ).rejects.toMatchObject({ reason: 'changed' });
    expect(store.acceptPreview).toHaveBeenCalledOnce();
  });

  it('uses the composition-owned evaluator for expression mappings', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'value',
      value: { encoding: 'utf8', value: 'evaluated' },
      canonicalBytes: 39,
    });
    const evaluator: ExpressionEvaluator = {
      evaluate,
    };
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(
        draft({
          graphJson: {
            ...graph(),
            nodes: [
              {
                ...graph().nodes[0],
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
      ),
    });
    const useCase = new TestWorkflowNodeUseCase(
      store,
      authorization(),
      undefined,
      evaluator,
    );

    await expect(
      useCase.execute({
        ...requestInput(),
        request: {
          mode: 'validate',
          expectedRevision: 3,
          sampleInput: { body: 'source' },
        },
      }),
    ).resolves.toMatchObject({ valid: true, issues: [] });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ expression: 'runInput.body' }),
    );
  });

  it('returns pure bounded validation and never accepts execution', async () => {
    const store = persistence();
    const access = authorization();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access,
      disclosure: 'not_found',
    });
    const useCase = new TestWorkflowNodeUseCase(store, access);
    await expect(
      useCase.execute({
        ...requestInput(),
        authorizedWorkspace,
        request: {
          mode: 'validate',
          expectedRevision: 3,
          sampleInput: {
            body: { encoding: 'utf8', value: 'hello' },
          },
        },
      }),
    ).resolves.toMatchObject({
      mode: 'validate',
      valid: true,
      revision: 3,
      nodeId: 'http',
      issues: [],
      disclosure: {
        sideEffectClass: 'unsafe',
        mayContactProvider: true,
        mayCauseExternalSideEffect: true,
      },
    });
    expect(store.acceptPreview).not.toHaveBeenCalled();
    // One guard lookup plus the distinct connection:use check; the duplicate
    // workflow:update use-case lookup is gone.
    expect(access.findAccess).toHaveBeenCalledTimes(2);
  });

  it('maps a missing visible draft before node preparation', async () => {
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(null),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        request: { mode: 'validate', expectedRevision: 3 },
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('reports the exact current revision representation after draft mutation', async () => {
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(draft({ revision: 4 })),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        request: { mode: 'validate', expectedRevision: 3 },
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRevisionConflictError',
      currentRevision: 4,
      currentEtag: '"draft.8TzCes2UynZ5w_QC7b_vUnsZkX8j-vonJu1MhXrf27o"',
    });
  });

  it('preserves an unknown draft-read failure by identity', async () => {
    const failure = new Error('draft store unavailable');
    const store = persistence({
      getDraft: vi.fn().mockRejectedValue(failure),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        request: { mode: 'validate', expectedRevision: 3 },
      }),
    ).rejects.toBe(failure);
  });

  it.each(['http', 'validate'] as const)(
    'rejects malformed %s config before accepting preview execution',
    async (kind) => {
      const invalidGraph =
        kind === 'http'
          ? graphWithConfig({
              ...graph().nodes[0].config,
              timeoutMillis: 0,
            })
          : {
              ...graph(),
              nodes: [
                {
                  ...graph().nodes[0],
                  definition: { key: 'core.validate', version: 1 },
                  config: { rules: [{ id: 'bad', path: '$.*' }] },
                  inputMappings: {},
                  connectionRefs: {},
                },
              ],
            };
      const store = persistence({
        getDraft: vi.fn().mockResolvedValue(
          draft({
            graphJson: invalidGraph,
          }),
        ),
      });
      const useCase = new TestWorkflowNodeUseCase(store, authorization());

      const result = await useCase
        .execute({
          ...requestInput(),
          idempotencyKey: 'preview-invalid-config',
          request: {
            mode: 'test_execute',
            expectedRevision: 3,
            acknowledgeSideEffects: true,
            input: {
              kind: 'manual',
              value: { body: { encoding: 'utf8', value: 'hello' } },
            },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(result).toBeInstanceOf(NodeTestInvalidError);
      if (!(result instanceof NodeTestInvalidError)) return;
      expect(
        result.issues.some(
          ({ code, path }) =>
            code === 'node.config_invalid' &&
            path ===
              (kind === 'http'
                ? '$.config.timeoutMillis'
                : '$.config.rules[0].path'),
        ),
      ).toBe(true);
      expect(store.acceptPreview).not.toHaveBeenCalled();
    },
  );

  it('denies validation when a referenced connection is not authorized', async () => {
    const store = persistence();
    const access = authorization();
    access.findAccess
      .mockResolvedValueOnce({
        actorId,
        workspaceId,
        role: 'builder',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      })
      .mockResolvedValueOnce({
        actorId,
        workspaceId,
        role: 'viewer',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      });
    const useCase = new TestWorkflowNodeUseCase(store, access);

    await expect(
      useCase.execute({
        ...requestInput(),
        request: {
          mode: 'validate',
          expectedRevision: 3,
          sampleInput: {
            body: { encoding: 'utf8', value: 'hello' },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    expect(access.findAccess).toHaveBeenCalledTimes(2);
    expect(store.getDraft).toHaveBeenCalledOnce();
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('denies execution before reading a draft without workflow update authority', async () => {
    const store = persistence();
    const access = authorization();
    access.findAccess.mockResolvedValue({
      actorId,
      workspaceId,
      role: 'operator',
      membershipStatus: 'active',
      workspaceStatus: 'active',
    });
    const useCase = new TestWorkflowNodeUseCase(store, access);

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-denied-workflow-update',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    expect(access.findAccess).toHaveBeenCalledOnce();
    expect(store.getDraft).not.toHaveBeenCalled();
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('denies execution when a referenced connection is not authorized', async () => {
    const store = persistence();
    const access = authorization();
    access.findAccess
      .mockResolvedValueOnce({
        actorId,
        workspaceId,
        role: 'builder',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      })
      .mockResolvedValueOnce({
        actorId,
        workspaceId,
        role: 'viewer',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      });
    const useCase = new TestWorkflowNodeUseCase(store, access);

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-denied-connection-use',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    expect(access.findAccess).toHaveBeenCalledTimes(2);
    expect(store.getDraft).toHaveBeenCalledOnce();
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('requires idempotency before accepting acknowledged execution', async () => {
    const useCase = new TestWorkflowNodeUseCase(persistence(), authorization());
    await expect(
      useCase.execute({
        ...requestInput(),
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'idempotency_required',
      name: 'NodeTestRequestError',
    });
  });

  it('rejects incompatible config identity before preview acceptance', async () => {
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(
        draft({
          graphJson: {
            ...graph(),
            nodes: [{ ...graph().nodes[0], configVersion: 2 }],
          },
        }),
      ),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-config-mismatch',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'NodeTestInvalidError',
      issues: [
        {
          path: '$.configVersion',
          code: 'node.config_version_incompatible',
          message: 'Selected node configuration version is incompatible',
        },
      ],
    });
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('returns the retained preview before reading a mutated draft', async () => {
    const retained = nodeTestingPreview({ status: 'succeeded' });
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(draft({ revision: 4 })),
      resolvePreviewReplay: vi.fn().mockResolvedValue(retained),
    });
    const access = authorization();
    const useCase = new TestWorkflowNodeUseCase(store, access);

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-replay',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: { kind: 'manual', value: { original: true } },
        },
      }),
    ).resolves.toEqual({
      mode: 'test_execute',
      replayed: true,
      preview: {
        id: retained.id,
        workspaceId,
        workflowId,
        draftRevision: 3,
        nodeId: 'http',
        status: 'succeeded',
        disclosure: {
          sideEffectClass: 'unsafe',
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          dryRun: 'not_supported',
        },
        output: null,
        safeErrorCode: null,
        createdAt: acceptedAt.toISOString(),
        startedAt: null,
        completedAt: null,
        expiresAt: expiresAt.toISOString(),
      },
    });
    expect(store.getDraft).not.toHaveBeenCalled();
    expect(store.acceptPreview).not.toHaveBeenCalled();
    expect(access.findAccess).toHaveBeenCalledOnce();
  });

  it('maps changed content under the same replay key before reading the draft', async () => {
    const store = persistence({
      resolvePreviewReplay: vi
        .fn()
        .mockRejectedValue(new PreviewIdempotencyConflictError()),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-conflict',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: { kind: 'manual', value: { changed: true } },
        },
      }),
    ).rejects.toBeInstanceOf(PreviewIdempotencyConflictError);
    expect(store.getDraft).not.toHaveBeenCalled();
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('maps an atomic-admission idempotency conflict after a replay miss', async () => {
    const store = persistence({
      acceptPreview: vi
        .fn()
        .mockRejectedValue(new PreviewIdempotencyConflictError()),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-raced-conflict',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      }),
    ).rejects.toBeInstanceOf(PreviewIdempotencyConflictError);
    expect(store.resolvePreviewReplay).toHaveBeenCalledOnce();
    expect(store.acceptPreview).toHaveBeenCalledOnce();
  });

  it('still rejects a stale revision when a new key has no replay', async () => {
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(draft({ revision: 4 })),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-new-key',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: { kind: 'manual', value: {} },
        },
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRevisionConflictError',
      currentRevision: 4,
    });
    expect(store.resolvePreviewReplay).toHaveBeenCalledOnce();
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('accepts one identifier-only durable preview', async () => {
    const result = accepted();
    const store = persistence({
      acceptPreview: vi.fn().mockResolvedValue(result),
    });
    const access = authorization();
    const useCase = new TestWorkflowNodeUseCase(
      store,
      access,
      () => acceptedAt,
    );
    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-key-1',
        requestId: 'request-node-test',
        traceId: 'trace-node-test',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      }),
    ).resolves.toMatchObject({
      mode: 'test_execute',
      replayed: false,
      preview: {
        id: result.previewRunId,
        status: 'queued',
        output: null,
      },
    });
    expect(store.resolvePreviewReplay).toHaveBeenCalledWith({
      workspaceId,
      actorUserId: actorId,
      workflowId,
      keyHash:
        'accd77133ae7eebe4e92bf6657b8c2a58554bb2521d24c68997f5b84cfc18928',
      requestHash:
        '856f5e84fd6a4bcc3d4d5045c7eea9d970d33275f1ad1fbbdab85e50e4cfdbf2',
    });
    expect(store.acceptPreview).toHaveBeenCalledWith({
      workspaceId,
      workflowId,
      expectedSampleId: null,
      actorUserId: actorId,
      draftRevision: 3,
      draftFingerprint:
        'b8dce9f3299b1828457eecfac123a9960fe6221756835bbc47005e9e08c512f2',
      nodeId: 'http',
      definitionKey: 'http.request',
      definitionVersion: 1,
      executorKey: 'http.request',
      executorVersion: 1,
      executableNode: {
        id: 'http',
        definition: { key: 'http.request', version: 1 },
        configVersion: 1,
        config: graph().nodes[0].config,
        inputMappings: graph().nodes[0].inputMappings,
        connectionRefs: graph().nodes[0].connectionRefs,
      },
      input: {
        kind: 'manual',
        value: { body: { encoding: 'utf8', value: 'hello' } },
      },
      sideEffectClass: 'unsafe',
      mayContactProvider: true,
      mayCauseExternalSideEffect: true,
      dryRun: 'not_supported',
      keyHash:
        'accd77133ae7eebe4e92bf6657b8c2a58554bb2521d24c68997f5b84cfc18928',
      requestHash:
        '856f5e84fd6a4bcc3d4d5045c7eea9d970d33275f1ad1fbbdab85e50e4cfdbf2',
      operation: 'preview.execute',
      operationKey: 'request',
      providerKey: 'http',
      scope: `${actorId}:${workflowId}`,
      expiresAt,
      executionDeadlineAt: new Date('2026-08-22T20:05:00.000Z'),
      requestId: 'request-node-test',
      traceId: 'trace-node-test',
    });
    expect(access.findAccess).toHaveBeenCalledTimes(2);
  });

  it('defers prior-preview value resolution to the tenant transaction', async () => {
    const store = persistence();
    const useCase = new TestWorkflowNodeUseCase(
      store,
      authorization(),
      () => acceptedAt,
    );
    const priorPreviewRunId = randomUUID();
    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-key-2',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: { kind: 'prior_preview', previewRunId: priorPreviewRunId },
        },
      }),
    ).resolves.toMatchObject({ mode: 'test_execute' });
    expect(store.acceptPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { kind: 'prior_preview', previewRunId: priorPreviewRunId },
      }),
    );
  });

  it('derives the exact provider key for an idempotent-with-key definition', async () => {
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(
        draft({
          graphJson: emailGraph(),
          compatibility: {
            compatible: true,
            fingerprint: `wf-compat:sha256:${'c'.repeat(64)}`,
            issues: [],
          },
        }),
      ),
    });
    const useCase = new TestWorkflowNodeUseCase(
      store,
      authorization(),
      () => acceptedAt,
    );

    await useCase.execute({
      ...requestInput(),
      nodeId: 'email',
      idempotencyKey: 'preview-email-key',
      request: {
        mode: 'test_execute',
        expectedRevision: 3,
        acknowledgeSideEffects: true,
        input: {
          kind: 'manual',
          value: {
            toEmail: 'Recipient@example.com',
            subject: 'Deployment complete',
            text: 'Production is healthy.',
          },
        },
      },
    });

    expect(store.acceptPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        sideEffectClass: 'idempotent_with_key',
        draftFingerprint:
          'a61a19e1a91f5138ca073a04bce5bcf83f10e0b640dd0d2e66d7f47b532f57de',
        keyHash:
          '54058cf53edec407d0ccfb201e69ae10fd5fde6a2a5c2b152a370f72ccb52726',
        requestHash:
          '616ce34a38b2267400e0a67fa66054d2c75e99ab46649d7fd4faffa79584d96e',
        providerIdempotencyKey:
          'pv1.58d1151e9148eb0a4e76496f61ba188215646c88a155804f5782e0014c8794f9',
      }),
    );
  });
});
describe('preview status application use case', () => {
  it('denies before reading when the caller lacks workflow update authority', async () => {
    const readPreview = vi.fn().mockResolvedValue(nodeTestingPreview());
    const access = authorization();
    access.findAccess.mockResolvedValue(undefined);
    const useCase = new GetPreviewRunUseCase({ readPreview }, access);

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    expect(readPreview).not.toHaveBeenCalled();
  });

  it('maps a missing scoped preview to hidden not-found', async () => {
    const readPreview = vi.fn().mockResolvedValue(null);
    const useCase = new GetPreviewRunUseCase({ readPreview }, authorization());

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it.each([
    ['null', null, null],
    [
      'inline',
      { kind: 'inline', value: { ok: true } },
      { kind: 'inline', value: { ok: true } },
    ],
    [
      'artifact',
      {
        kind: 'artifact',
        artifactId: '11111111-1111-4111-8111-111111111111',
      },
      {
        kind: 'artifact',
        artifactId: '11111111-1111-4111-8111-111111111111',
      },
    ],
  ] as const)(
    'projects complete %s output exactly',
    async (_name, output, projected) => {
      const startedAt = new Date('2026-08-22T20:01:00.000Z');
      const completedAt = new Date('2026-08-22T20:02:00.000Z');
      const readPreview = vi.fn().mockResolvedValue(
        nodeTestingPreview({
          status: 'succeeded',
          output,
          safeErrorCode: 'provider.completed',
          startedAt,
          completedAt,
        }),
      );
      const useCase = new GetPreviewRunUseCase(
        { readPreview },
        authorization(),
      );

      await expect(
        useCase.execute({
          actor,
          routeWorkspaceId: workspaceId,
          previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        }),
      ).resolves.toEqual({
        preview: {
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          workspaceId,
          workflowId,
          draftRevision: 3,
          nodeId: 'http',
          status: 'succeeded',
          disclosure: {
            sideEffectClass: 'unsafe',
            mayContactProvider: true,
            mayCauseExternalSideEffect: true,
            dryRun: 'not_supported',
          },
          output: projected,
          safeErrorCode: 'provider.completed',
          createdAt: acceptedAt.toISOString(),
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
      });
      expect(readPreview).toHaveBeenCalledWith({
        workspaceId,
        actorUserId: actorId,
        previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });
    },
  );

  it('reuses a frozen matching guard context without another access lookup', async () => {
    const access = authorization();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access,
      disclosure: 'not_found',
    });
    const readPreview = vi.fn().mockResolvedValue(nodeTestingPreview());
    access.findAccess.mockClear();
    const useCase = new GetPreviewRunUseCase({ readPreview }, access);

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        authorizedWorkspace,
        previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    ).resolves.toMatchObject({ preview: { status: 'queued' } });
    expect(Object.isFrozen(authorizedWorkspace)).toBe(true);
    expect(access.findAccess).not.toHaveBeenCalled();
  });
});
