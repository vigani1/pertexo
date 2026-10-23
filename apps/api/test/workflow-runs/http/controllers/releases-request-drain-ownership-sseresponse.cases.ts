import { expect, it, vi } from 'vitest';

import { ApiDrainState } from '../../../../src/platform/health/drain-state.js';

import {
  workspaceId,
  runId,
  request,
  sseReply,
  controller,
  streamController,
} from './fixture.js';

export function registerReleasesRequestDrainOwnershipSSEResponse(): void {
  it('releases request and drain ownership when SSE response preparation fails before producer acquisition', async () => {
    const preparationFailure = new Error('flush headers failed');
    const iteratorFactory = vi.fn();
    const stream = {
      execute: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: iteratorFactory,
      }),
    };
    const drainState = new ApiDrainState();
    const instance = streamController(
      stream,
      { recordFirstEligibleFrame: vi.fn() },
      drainState,
    );
    const selectedRequest = request();
    const removeCloseListener = vi.spyOn(selectedRequest.raw, 'off');
    const reply = sseReply();
    reply.raw.flushHeaders = vi.fn(() => {
      throw preparationFailure;
    });

    await expect(
      instance.streamRunEvents(
        selectedRequest,
        { workspaceId, runId },
        reply as never,
      ),
    ).rejects.toBe(preparationFailure);

    expect(iteratorFactory).not.toHaveBeenCalled();
    expect(removeCloseListener).toHaveBeenCalledOnce();
    expect(drainState.activeStreamCount()).toBe(0);
  });

  it('ends and destroys a committed response when the producer iterator factory throws', async () => {
    const iteratorFailure = new Error('producer iterator failed');
    const stream = {
      execute: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: () => {
          throw iteratorFailure;
        },
      }),
    };
    const drainState = new ApiDrainState();
    const instance = streamController(
      stream,
      { recordFirstEligibleFrame: vi.fn() },
      drainState,
    );
    const selectedRequest = request();
    const removeCloseListener = vi.spyOn(selectedRequest.raw, 'off');
    const reply = sseReply();

    await expect(
      instance.streamRunEvents(
        selectedRequest,
        { workspaceId, runId },
        reply as never,
      ),
    ).resolves.toBeUndefined();

    const end = vi.mocked(reply.raw.end);
    expect(end).toHaveBeenCalledOnce();
    expect(reply.raw.destroyed).toBe(true);
    expect(removeCloseListener).toHaveBeenCalledOnce();
    expect(drainState.activeStreamCount()).toBe(0);
  });

  it('forwards durable cancellation actor, reason, and trace context', async () => {
    const fixture = controller();
    await fixture.instance.cancelRun(
      request({
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      }),
      { workspaceId, runId },
      { reason: 'operator request' },
    );

    expect(fixture.cancel.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        runId,
        reason: 'operator request',
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
  });
}
