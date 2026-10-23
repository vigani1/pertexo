import { expect, it, vi } from 'vitest';

import {
  StreamRunEventsUseCase,
  WorkflowRunNotFoundError,
} from '../../../src/workflow-runs/use-cases.js';

import type { WorkflowRunEventStreamer } from '../../../src/workflow-runs/ports.js';
import {
  actorId,
  sessionId,
  workspaceId,
  runId,
  actor,
  authorization,
  persistence,
} from './fixture.js';

export function registerDoesNotAcquireProducerStartAuthorization(): void {
  it('does not acquire the producer or start authorization when returned before the first read', async () => {
    const fixture = persistence();
    const stream = vi.fn<WorkflowRunEventStreamer['stream']>();
    const reauthorizeSession = vi.fn();
    const frames = await new StreamRunEventsUseCase(
      fixture.store,
      authorization('viewer'),
      { stream },
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      lastEventId: 0,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      reauthorizeSession,
      abortStream: vi.fn(),
      signal: new AbortController().signal,
    });

    const iterator = frames[Symbol.asyncIterator]();
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(stream).not.toHaveBeenCalled();
    expect(reauthorizeSession).not.toHaveBeenCalled();
  });

  it.each(['stream factory', 'iterator factory'] as const)(
    'contains a throwing %s before authorization lifetime starts',
    async (failurePoint) => {
      const fixture = persistence();
      const failure = new Error(`${failurePoint} failed`);
      const reauthorizeSession = vi.fn();
      const stream = vi.fn<WorkflowRunEventStreamer['stream']>(() => {
        if (failurePoint === 'stream factory') throw failure;
        return {
          [Symbol.asyncIterator]: () => {
            throw failure;
          },
        };
      });
      const frames = await new StreamRunEventsUseCase(
        fixture.store,
        authorization('viewer'),
        { stream },
      ).execute({
        actor,
        routeWorkspaceId: workspaceId,
        runId,
        lastEventId: 0,
        sessionExpiresAt: new Date(Date.now() + 60_000),
        reauthorizeSession,
        abortStream: vi.fn(),
        signal: new AbortController().signal,
      });

      await expect(frames[Symbol.asyncIterator]().next()).rejects.toBe(failure);
      expect(stream).toHaveBeenCalledOnce();
      expect(reauthorizeSession).not.toHaveBeenCalled();
    },
  );

  it('reauthorizes before later frames and stops after membership removal', async () => {
    const fixture = persistence();
    const access = authorization('viewer');
    const later = Promise.withResolvers<undefined>();
    let cleanedUp = false;
    const streamer = {
      stream: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          try {
            yield { id: 1, event: 'run.started', data: '{}' };
            await later.promise;
            yield { id: 2, event: 'run.succeeded', data: '{}' };
          } finally {
            cleanedUp = true;
          }
        },
      }),
    };
    const frames = await new StreamRunEventsUseCase(
      fixture.store,
      access,
      streamer,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      lastEventId: 0,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
      abortStream: vi.fn(),
      reauthorizeSession: vi.fn().mockResolvedValue({
        userId: actorId,
        sessionId,
        expiresAt: new Date(Date.now() + 60_000),
        clientMetadata: {},
      }),
    });
    const iterator = frames[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: 1 },
    });
    access.findAccess.mockResolvedValue({
      actorId,
      workspaceId,
      role: 'viewer',
      membershipStatus: 'suspended',
      workspaceStatus: 'active',
    });
    later.resolve(undefined);

    await expect(iterator.next()).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    expect(access.findAccess).toHaveBeenCalledTimes(3);
    expect(cleanedUp).toBe(true);
  });

  it('stops before later frames after folder access is revoked while membership stays active', async () => {
    const fixture = persistence();
    const canRead = vi.fn().mockResolvedValue(true);
    fixture.store.canRead = canRead;
    const access = authorization('viewer');
    const later = Promise.withResolvers<undefined>();
    let cleanedUp = false;
    const streamer = {
      stream: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          try {
            yield { id: 1, event: 'run.started', data: '{}' };
            await later.promise;
            yield { id: 2, event: 'run.succeeded', data: '{}' };
          } finally {
            cleanedUp = true;
          }
        },
      }),
    };
    const frames = await new StreamRunEventsUseCase(
      fixture.store,
      access,
      streamer,
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      runId,
      lastEventId: 0,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      signal: new AbortController().signal,
      abortStream: vi.fn(),
      reauthorizeSession: vi.fn().mockResolvedValue({
        userId: actorId,
        sessionId,
        expiresAt: new Date(Date.now() + 60_000),
        clientMetadata: {},
      }),
    });
    const iterator = frames[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: 1 },
    });
    canRead.mockResolvedValue(false);
    later.resolve(undefined);

    await expect(iterator.next()).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError,
    );
    expect(access.findAccess).toHaveBeenCalledTimes(3);
    expect(cleanedUp).toBe(true);
  });
}
