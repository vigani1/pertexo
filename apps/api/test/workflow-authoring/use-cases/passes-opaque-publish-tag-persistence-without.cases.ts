import { expect, it, vi } from 'vitest';
import {
  PublishWorkflowUseCase,
  SaveWorkflowDraftUseCase,
} from '../../../src/workflow-authoring/use-cases.js';
import { createDraftRepresentationTag } from '../../../src/workflow-authoring/http/etag.js';
import { createActorContext } from '../../../src/authorization/index.js';
import type { WorkflowAuthoringPersistence } from '../../../src/workflow-authoring/ports.js';
import type { PublishWorkflowInput as DatabasePublishWorkflowInput } from '@pertexo/core/testing';
import { WorkflowRevisionConflictError } from '@pertexo/core/testing';

import {
  actorId,
  sessionId,
  workspaceId,
  workflowId,
  fingerprint,
  graph,
  actor,
  draft,
  version,
  authorization,
  persistence,
} from './fixture.js';

export function registerPassesOpaquePublishTagPersistenceWithout(): void {
  it('passes the opaque publish tag to persistence without pre-rejecting it', async () => {
    let publishInput: DatabasePublishWorkflowInput | undefined;
    const store = persistence({
      publishWorkflow: (input) => {
        publishInput = input;
        return Promise.resolve({
          version: version(),
          reused: false,
          replayed: false,
        });
      },
    });
    const useCase = new PublishWorkflowUseCase(store, authorization());
    const tag = '"draft.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';

    await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      representationTag: tag,
      idempotencyKey: 'publish-42',
    });
    expect(publishInput?.representationTag).toBe(tag);
    expect(publishInput?.idempotencyKey).toBe('publish-42');
    expect(publishInput?.requestHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('forwards the operation signal without changing canonical publish identity or diagnostic exclusions', async () => {
    const tag = '"draft.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';
    const publishWorkflow = vi
      .fn<WorkflowAuthoringPersistence['publishWorkflow']>()
      .mockResolvedValue({
        version: version(),
        reused: false,
        replayed: false,
      });
    const useCase = new PublishWorkflowUseCase(
      persistence({ publishWorkflow }),
      authorization(),
    );
    const base = {
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      representationTag: tag,
      idempotencyKey: 'publish-hash',
    } as const;

    const withoutSignal = await useCase.execute(base);
    const expected =
      '84b9b240331d7c501453089c5a0083f865ba22275af0b6bcc443b7be7a7cd475';
    expect(publishWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestHash: expected }),
    );
    const signal = new AbortController().signal;
    const withSignal = await useCase.execute({
      ...base,
      signal,
      requestId: 'diagnostic-request',
      traceId: 'diagnostic-trace',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });
    expect(publishWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestHash: expected,
        representationTag: tag,
        idempotencyKey: base.idempotencyKey,
      }),
    );
    expect(publishWorkflow.mock.lastCall?.[0].signal).toBe(signal);
    expect(withSignal).toEqual(withoutSignal);
  });

  it('changes the canonical publish hash for actor, workspace, workflow, and original tag identity', async () => {
    const tag = '"draft.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';
    const actorTwoId = '11111111-1111-4111-8111-111111111111';
    const workspaceTwoId = '22222222-2222-4222-8222-222222222222';
    const workflowTwoId = '33333333-3333-4333-8333-333333333333';
    const tagTwo = '"draft.1234567890abcdefghijklmnopqrstuvwxyz_-ABCDE"';
    const hashes: string[] = [];
    const execute = async ({
      inputActor,
      routeWorkspaceId,
      inputWorkflowId,
      representationTag,
      access = authorization({
        actorId: inputActor.actorId,
        workspaceId: routeWorkspaceId,
      }),
    }: Readonly<{
      inputActor: typeof actor;
      routeWorkspaceId: string;
      inputWorkflowId: string;
      representationTag: string;
      access?: ReturnType<typeof authorization> | undefined;
    }>) => {
      const publishWorkflow = vi.fn((input: DatabasePublishWorkflowInput) => {
        hashes.push(input.requestHash);
        return Promise.resolve({
          version: version(),
          reused: false,
          replayed: false,
        });
      });
      await new PublishWorkflowUseCase(
        persistence({ publishWorkflow }),
        access,
      ).execute({
        actor: inputActor,
        routeWorkspaceId,
        workflowId: inputWorkflowId,
        representationTag,
        idempotencyKey: 'publish-hash-sensitivity',
      });
    };

    await execute({
      inputActor: actor,
      routeWorkspaceId: workspaceId,
      inputWorkflowId: workflowId,
      representationTag: tag,
    });
    await execute({
      inputActor: createActorContext({
        actorId: actorTwoId,
        workspaceId,
        sessionId,
        requestId: 'actor-two',
      }),
      routeWorkspaceId: workspaceId,
      inputWorkflowId: workflowId,
      representationTag: tag,
    });
    await execute({
      inputActor: createActorContext({
        actorId,
        workspaceId: workspaceTwoId,
        sessionId,
        requestId: 'workspace-two',
      }),
      routeWorkspaceId: workspaceTwoId,
      inputWorkflowId: workflowId,
      representationTag: tag,
    });
    await execute({
      inputActor: actor,
      routeWorkspaceId: workspaceId,
      inputWorkflowId: workflowTwoId,
      representationTag: tag,
    });
    await execute({
      inputActor: actor,
      routeWorkspaceId: workspaceId,
      inputWorkflowId: workflowId,
      representationTag: tagTwo,
    });

    expect(new Set(hashes).size).toBe(5);
  });

  it('lets persistence resolve an exact publish replay before reading a fresh draft', async () => {
    const getDraft = vi
      .fn()
      .mockRejectedValue(
        new Error('publish replay must not perform a fresh draft read'),
      );
    const publishWorkflow = vi.fn().mockResolvedValue({
      version: version(),
      reused: true,
      replayed: true,
    });
    const store = persistence({ getDraft, publishWorkflow });
    const result = await new PublishWorkflowUseCase(
      store,
      authorization(),
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      representationTag: '"draft.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"',
      idempotencyKey: 'publish-replay-42',
    });

    expect(result.reused).toBe(true);
    expect(publishWorkflow).toHaveBeenCalledOnce();
    expect(getDraft).not.toHaveBeenCalled();
  });

  it('reports a CAS conflict revision and ETag from one persistence snapshot', async () => {
    const currentEtag = createDraftRepresentationTag({
      workflowId,
      revision: 2,
      graph,
      compatibilityFingerprint: fingerprint,
    });
    const getDraft = vi.fn().mockResolvedValue(draft());
    const saveDraft = vi
      .fn()
      .mockRejectedValue(new WorkflowRevisionConflictError(2, currentEtag));
    const store = persistence({ getDraft, saveDraft });
    const failure = await new SaveWorkflowDraftUseCase(store, authorization())
      .execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        representationTag: createDraftRepresentationTag({
          workflowId,
          revision: 1,
          graph,
          compatibilityFingerprint: fingerprint,
        }),
        graph,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkflowRevisionConflictError);
    if (!(failure instanceof WorkflowRevisionConflictError))
      throw new Error('expected workflow revision conflict');
    expect(failure.currentRevision).toBe(2);
    expect(failure.currentEtag).toBe(currentEtag);
    expect(getDraft).toHaveBeenCalledOnce();
  });
}
