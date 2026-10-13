import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { useRetainedSubmission } from '@/features/workflow-runs/data/mutations/use-retained-submission';
const apiClient: ApiClient = { request: vi.fn(), stream: vi.fn() };
const scope = {
  apiClient,
  userId: 'user',
  workspaceId: 'workspace',
  sourceRunId: 'source',
  workflowVersionId: 'version',
};
function network() {
  return new ApiError({ kind: 'network', message: 'Response lost' });
}
describe('one retained run acceptance intent', () => {
  it('fences same-tick duplicates and preserves the reviewed value', async () => {
    let resolve: (id: string) => void = () => undefined;
    const send = vi.fn(
      (_intent: { value: { a: number } }, _key: string) =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const accepted = vi.fn();
    const { result } = renderHook(() =>
      useRetainedSubmission({
        ...scope,
        normalize: JSON.stringify,
        send,
        describeError: () => 'Unknown',
        onAccepted: accepted,
      }),
    );
    const intent = { value: { a: 1 } };
    let first: Promise<boolean> = Promise.resolve(false),
      second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = result.current.startNew(intent);
      second = result.current.startNew(intent);
    });
    intent.value.a = 2;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual({ value: { a: 1 } });
    await act(async () => {
      resolve('new-run');
      await first;
      expect(await second).toBe(false);
    });
    expect(accepted).toHaveBeenCalledOnce();
  });
  it('keeps exact acceptance retries across dismiss and refuses changed values', async () => {
    const send = vi
      .fn<(intent: { a: number }, key: string) => Promise<string>>()
      .mockRejectedValueOnce(network())
      .mockResolvedValue('new-run');
    const { result } = renderHook(() =>
      useRetainedSubmission({
        ...scope,
        normalize: JSON.stringify,
        send,
        describeError: () => 'Unknown',
        onAccepted: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.startNew({ a: 1 });
    });
    act(() => {
      result.current.dismiss();
    });
    await act(async () => {
      expect(await result.current.startNew({ a: 2 })).toBe(false);
      expect(await result.current.retry({ a: 2 })).toBe(false);
    });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.retry();
    });
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  });
  it('does not re-admit an expired uncertain intent', async () => {
    const clock = vi.spyOn(Date, 'now');
    const at = Date.now();
    clock.mockReturnValue(at);
    const send = vi.fn().mockRejectedValue(network());
    try {
      const { result } = renderHook(() =>
        useRetainedSubmission({
          ...scope,
          normalize: JSON.stringify,
          send,
          describeError: () => 'Unknown',
          onAccepted: vi.fn(),
        }),
      );
      await act(async () => {
        await result.current.startNew({ a: 1 });
      });
      clock.mockReturnValue(at + 86_400_000);
      await act(async () => {
        expect(await result.current.retry()).toBe(false);
      });
      expect(send).toHaveBeenCalledOnce();
      expect(result.current.error).toContain('24-hour');
    } finally {
      clock.mockRestore();
    }
  });
  it('ignores acceptance after the owning actor changes', async () => {
    let resolve: (id: string) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const accepted = vi.fn();
    const { result, rerender } = renderHook(
      ({ userId }) =>
        useRetainedSubmission({
          ...scope,
          userId,
          normalize: JSON.stringify,
          send,
          describeError: () => 'Unknown',
          onAccepted: accepted,
        }),
      { initialProps: { userId: 'first' } },
    );
    let pending: Promise<boolean> = Promise.resolve(false);
    act(() => {
      pending = result.current.startNew({ a: 1 });
    });
    rerender({ userId: 'second' });
    await act(async () => {
      resolve('old-actor-run');
      expect(await pending).toBe(false);
    });
    expect(accepted).not.toHaveBeenCalled();
  });
  it('treats an HTTP server failure as unconfirmed admission rather than a fresh intent', async () => {
    const send = vi.fn().mockRejectedValue(
      new ApiError({
        kind: 'problem',
        status: 500,
        message: 'Server failure',
      }),
    );
    const { result } = renderHook(() =>
      useRetainedSubmission({
        ...scope,
        normalize: JSON.stringify,
        send,
        describeError: () => 'Unknown',
        onAccepted: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.startNew({ a: 1 });
    });
    expect(result.current.unconfirmed).toBe(true);
  });
  it('never sends the previous actor’s uncertain intent through a new scope', async () => {
    const send = vi.fn().mockRejectedValue(network());
    const { result, rerender } = renderHook(
      ({ userId }) =>
        useRetainedSubmission({
          ...scope,
          userId,
          normalize: JSON.stringify,
          send,
          describeError: () => 'Unknown',
          onAccepted: vi.fn(),
        }),
      { initialProps: { userId: 'first' } },
    );
    await act(async () => {
      await result.current.startNew({ a: 1 });
    });
    rerender({ userId: 'second' });
    await act(async () => {
      expect(await result.current.retry()).toBe(false);
    });
    expect(send).toHaveBeenCalledOnce();
    expect(result.current.error).toContain('previous run or signed-in account');
  });
});
