import { randomUUID } from 'node:crypto';

import { expect, it, vi } from 'vitest';

import { TestWorkflowNodeUseCase } from '../../../src/node-testing/use-case.js';

import {
  actorId,
  workspaceId,
  workflowId,
  acceptedAt,
  expiresAt,
  graph,
  emailGraph,
  draft,
  accepted,
  persistence,
  authorization,
  requestInput,
} from './fixture.js';

export function registerAcceptsOneIdentifierDurablePreview(): void {
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
}
