import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCountdown, formatShortTime } from '../../src/lib/format-time';
import { useCountdown } from '../../src/lib/use-countdown';
import { useNow } from '../../src/lib/use-now';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-24T12:00:00Z') });
});

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

describe('useNow', () => {
  it('ticks only while enabled', () => {
    const start = Date.now();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useNow(1_000, enabled),
      { initialProps: { enabled: false } },
    );
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe(start);

    rerender({ enabled: true });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(start + 4_000);
  });

  it('pauses while the tab is hidden and catches up when shown', () => {
    const start = Date.now();
    const { result } = renderHook(() => useNow(1_000));
    act(() => {
      setHidden(true);
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(start);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      setHidden(false);
    });
    expect(result.current).toBe(start + 5_000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops once `untilMs` has passed', () => {
    const until = Date.now() + 2_000;
    const { result } = renderHook(() => useNow(1_000, true, until));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(until);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useCountdown', () => {
  it('counts whole seconds toward its deadline and then stops', () => {
    const { result } = renderHook(() => useCountdown());
    expect(result.current.remainingSeconds).toBe(0);

    act(() => {
      result.current.startSeconds(3);
    });
    expect(result.current.remainingSeconds).toBe(3);
    act(() => {
      vi.advanceTimersByTime(1_250);
    });
    expect(result.current.remainingSeconds).toBe(2);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.remainingSeconds).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts from the moment it is set, even after an idle clock', () => {
    const { result } = renderHook(() => useCountdown());
    act(() => {
      vi.advanceTimersByTime(60_000);
      result.current.startUntil(Date.now() + 10_000);
    });
    expect(result.current.remainingSeconds).toBe(10);

    act(() => {
      result.current.clear();
    });
    expect(result.current.remainingSeconds).toBe(0);
  });
});

describe('formatCountdown', () => {
  it('reads as minutes and padded seconds', () => {
    expect(formatCountdown(24)).toBe('0:24');
    expect(formatCountdown(299.2)).toBe('5:00');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});

describe('formatShortTime', () => {
  it('reads the time to the minute in the person’s locale, without seconds', () => {
    const at = new Date(2026, 8, 24, 14, 31, 45);
    const expected = new Intl.DateTimeFormat(undefined, {
      timeStyle: 'short',
    }).format(at);
    expect(formatShortTime(at.toISOString())).toBe(expected);
    expect(formatShortTime(at.getTime())).toBe(expected);
    expect(formatShortTime(at.getTime())).toMatch(/31/u);
    expect(formatShortTime(at.getTime())).not.toMatch(/45/u);
  });

  it('renders a dash for a missing or unreadable time', () => {
    expect(formatShortTime(null)).toBe('—');
    expect(formatShortTime('not a time')).toBe('—');
  });
});
