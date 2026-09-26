import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLatestRequest } from '@/lib/use-latest-request';

describe('useLatestRequest', () => {
  it('stays pending until the current request finishes, whatever an older one does', () => {
    const { result } = renderHook(() => useLatestRequest());
    expect(result.current.pending).toBe(false);

    let first = undefined as
      ReturnType<typeof result.current.begin> | undefined;
    act(() => {
      first = result.current.begin();
    });
    expect(result.current.pending).toBe(true);

    let second = undefined as
      ReturnType<typeof result.current.begin> | undefined;
    act(() => {
      second = result.current.begin();
    });
    // Starting again cancels the first request.
    expect(first?.signal.aborted).toBe(true);
    expect(first?.isCurrent()).toBe(false);

    // The first answering late can't end the second request's wait.
    act(() => {
      expect(first?.finish()).toBe(false);
    });
    expect(result.current.pending).toBe(true);

    act(() => {
      expect(second?.finish()).toBe(true);
    });
    expect(result.current.pending).toBe(false);
  });

  it('ends pending when the request in flight is dropped, and aborts on unmount', () => {
    const { result, unmount } = renderHook(() => useLatestRequest());
    let request = undefined as
      ReturnType<typeof result.current.begin> | undefined;
    act(() => {
      result.current.begin();
      result.current.abort();
    });
    expect(result.current.pending).toBe(false);

    act(() => {
      request = result.current.begin();
    });
    unmount();
    expect(request?.signal.aborted).toBe(true);
  });
});
