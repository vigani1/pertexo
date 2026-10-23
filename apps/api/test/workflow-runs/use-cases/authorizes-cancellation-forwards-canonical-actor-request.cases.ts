import { expect, it, vi } from 'vitest';
import { createActorContext } from '../../../src/authorization/index.js';
import {
  CancelWorkflowRunUseCase,
  GetWorkflowRunUseCase,
  ReplayWorkflowRunUseCase,
  StartWorkflowRunUseCase,
  StreamRunEventsUseCase,
} from '../../../src/workflow-runs/use-cases.js';

import type { WorkflowRunEventStreamer } from '../../../src/workflow-runs/ports.js';
import {
  actorId,
  sessionId,
  workspaceId,
  workflowId,
  workflowVersionId,
  runId,
  now,
  actor,
  authorization,
  run,
  persistence,
} from './fixture.js';

export function registerAuthorizesCancellationForwardsCanonicalActorRequest(): void {
  it('authorizes cancellation and forwards canonical actor/request context', async () => {
    const fixture = persistence();
    await new CancelWorkflowRunUseCase(fixture.store, authorization()).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      reason: 'operator request',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });

    expect(fixture.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        workspaceId,
        runId,
        reason: 'operator request',
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
  });

  it('supports omitted and explicit request metadata across start, replay, and cancel', async () => {
    const fixture = persistence();
    const actorWithoutTrace = createActorContext({
      actorId,
      workspaceId,
      sessionId,
      requestId: 'actor-request',
    });

    await new StartWorkflowRunUseCase(fixture.store, authorization()).execute({
      actor: actorWithoutTrace,
      routeWorkspaceId: workspaceId,
      workflowId,
      idempotencyKey: 'start-minimal',
      requestId: 'start-request',
    });
    await new ReplayWorkflowRunUseCase(fixture.store, authorization()).execute({
      actor: actorWithoutTrace,
      routeWorkspaceId: workspaceId,
      runId,
      workflowVersionId,
      idempotencyKey: 'replay-minimal',
      input: null,
      requestId: 'replay-request',
      traceId: 'replay-trace',
    });
    await new CancelWorkflowRunUseCase(fixture.store, authorization()).execute({
      actor: actorWithoutTrace,
      routeWorkspaceId: workspaceId,
      runId,
      requestId: 'cancel-request',
      traceId: 'cancel-trace',
    });
    await new CancelWorkflowRunUseCase(fixture.store, authorization()).execute({
      actor: actorWithoutTrace,
      routeWorkspaceId: workspaceId,
      runId,
    });

    expect(fixture.start).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'start-request' }),
    );
    expect(fixture.start.mock.calls[0]?.[0]).not.toHaveProperty('traceId');
    expect(fixture.replay).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'replay-request',
        traceId: 'replay-trace',
      }),
    );
    expect(fixture.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'cancel-request',
        traceId: 'cancel-trace',
      }),
    );
    expect(fixture.cancel.mock.calls[0]?.[0]).not.toHaveProperty('reason');
    expect(fixture.cancel.mock.calls[0]?.[0]).not.toHaveProperty('traceparent');
    expect(fixture.cancel.mock.calls[1]?.[0]).not.toHaveProperty('traceId');
  });

  it.each(['get', 'stream'] as const)(
    'reports a missing run before %s behavior proceeds',
    async (operation) => {
      const fixture = persistence();
      fixture.get.mockResolvedValue(undefined);

      const execution =
        operation === 'get'
          ? new GetWorkflowRunUseCase(
              fixture.store,
              authorization('viewer'),
            ).execute({ actor, routeWorkspaceId: workspaceId, runId })
          : new StreamRunEventsUseCase(fixture.store, authorization('viewer'), {
              stream: vi.fn(),
            }).execute({
              actor,
              routeWorkspaceId: workspaceId,
              runId,
              lastEventId: 0,
              sessionExpiresAt: new Date(Date.now() + 60_000),
              reauthorizeSession: vi.fn(),
              abortStream: vi.fn(),
              signal: new AbortController().signal,
            });

      await expect(execution).rejects.toMatchObject({
        name: 'WorkflowRunNotFoundError',
      });
    },
  );

  it('serializes non-null run and node lifecycle timestamps', async () => {
    const fixture = persistence();
    fixture.get.mockResolvedValue({
      run: {
        ...run(),
        startedAt: now,
        completedAt: now,
        deadlineAt: now,
        cancelRequestedAt: now,
      },
      nodes: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          nodeId: 'node-1',
          invocationKey: 'node-1',
          status: 'succeeded',
          currentAttemptNumber: 1,
          startedAt: now,
          completedAt: now,
          resumeAt: now,
          safeErrorCode: null,
        },
      ],
    });

    const result = await new GetWorkflowRunUseCase(
      fixture.store,
      authorization('viewer'),
    ).execute({ actor, routeWorkspaceId: workspaceId, runId });

    expect(result.run.startedAt).toBe(now.toISOString());
    expect(result.nodes[0]).toMatchObject({
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      resumeAt: now.toISOString(),
    });
  });

  it('authorizes the stream, proves the run exists, and delegates the cursor', async () => {
    const fixture = persistence();
    const signal = new AbortController().signal;
    const frames = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield { id: 2, event: 'run.started', data: '{}' };
      },
    };
    const streamer = {
      stream: vi
        .fn<WorkflowRunEventStreamer['stream']>()
        .mockReturnValue(frames),
    };
    const result = await new StreamRunEventsUseCase(
      fixture.store,
      authorization('viewer'),
      streamer,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      lastEventId: 1,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      reauthorizeSession: vi.fn().mockResolvedValue({
        userId: actorId,
        sessionId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      abortStream: vi.fn(),
      signal,
    });

    expect(fixture.get).toHaveBeenCalledWith({
      actorId,
      workspaceId,
      runId,
      includeWorkflowName: false,
    });
    expect(streamer.stream).not.toHaveBeenCalled();
    const iterator = result[Symbol.asyncIterator]();
    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { id: 2 },
      });
    } finally {
      await iterator.return?.();
    }
    expect(streamer.stream).toHaveBeenCalledOnce();
    expect(streamer.stream.mock.calls[0]?.[0]).toMatchObject({
      workspaceId,
      runId,
      lastEventId: 1,
    });
    expect(streamer.stream.mock.calls[0]?.[0].signal).not.toBe(signal);
  });
}
