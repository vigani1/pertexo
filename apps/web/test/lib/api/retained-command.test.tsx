import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { ApiError } from '@/lib/api/error';
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
afterEach(() => vi.useRealTimers());
it('retains the exact command after a possible-commit 5xx and keeps uncertainty through a later refusal', async () => {
  let attempt = 0;
  const send = vi.fn((_body: { value: number }, _key: string) => {
    attempt++;
    return attempt < 3
      ? Promise.reject(
          new ApiError({
            kind: 'problem',
            status: attempt === 1 ? 502 : 404,
            message: 'Unconfirmed',
          }),
        )
      : Promise.resolve('accepted');
  });
  const accepted = vi.fn();
  const { result } = renderHook(() => useRetainedCommand(send, accepted), {
    wrapper: wrapper(),
  });
  const body = { value: 1 };
  await act(() => result.current.send(body));
  body.value = 2;
  expect(result.current.uncertain).toBe(true);
  await act(() => result.current.send(body));
  expect(send).toHaveBeenCalledTimes(1);
  await act(() => {
    result.current.retry();
    return Promise.resolve();
  });
  await waitFor(() => {
    expect(send).toHaveBeenCalledTimes(2);
  });
  expect(result.current.uncertain).toBe(true);
  act(() => {
    result.current.reset();
  });
  expect(result.current.uncertain).toBe(true);
  await act(() => {
    result.current.retry();
    return Promise.resolve();
  });
  await waitFor(() => {
    expect(accepted).toHaveBeenCalledTimes(1);
  });
  expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[2]);
  expect(send.mock.calls[0]?.[0]).toEqual({ value: 1 });
  expect(accepted).toHaveBeenCalledWith('accepted', { value: 1 });
  expect(result.current.uncertain).toBe(false);
});
it('refuses to resend after the receipt window instead of minting another key', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
  const send = vi.fn((_body: { value: number }, _key: string) =>
    Promise.reject(new ApiError({ kind: 'network', message: 'Lost response' })),
  );
  const { result } = renderHook(() => useRetainedCommand(send), {
    wrapper: wrapper(),
  });
  await act(() => result.current.send({ value: 1 }));
  vi.setSystemTime(new Date('2026-10-16T10:00:01Z'));
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(result.current.expired).toBe(true);
  await act(() => result.current.send({ value: 1 }));
  act(() => {
    result.current.retry();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(result.current.error).toContain('24-hour');
});
it('allows a corrected new intent after a definite initial refusal', async () => {
  const send = vi.fn((_body: { value: number }, _key: string) =>
    Promise.reject(
      new ApiError({ kind: 'problem', status: 400, message: 'Invalid' }),
    ),
  );
  const { result } = renderHook(() => useRetainedCommand(send), {
    wrapper: wrapper(),
  });
  await act(() => result.current.send({ value: 1 }));
  await act(() => result.current.send({ value: 2 }));
  expect(result.current.uncertain).toBe(false);
  expect(send.mock.calls[0]?.[1]).not.toBe(send.mock.calls[1]?.[1]);
});
