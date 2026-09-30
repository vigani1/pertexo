import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishSessionChange,
  subscribeSessionChanges,
} from '@/features/auth/session-sync.public';

const storageKey = 'pertexo:auth-session-change:v1';

afterEach(() => {
  localStorage.clear();
});

describe('cross-tab session signals', () => {
  it('stores only a non-secret notification and accepts a storage fallback once', () => {
    publishSessionChange();
    const stored = JSON.parse(
      localStorage.getItem(storageKey) ?? '{}',
    ) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'event',
      'generation',
      'sender',
    ]);
    expect(stored.event).toBe('changed');

    const onChange = vi.fn();
    const unsubscribe = subscribeSessionChanges(onChange);
    const otherTabSignal = JSON.stringify({
      event: 'changed',
      generation: 'other-generation',
      sender: 'other-tab',
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: storageKey,
        newValue: otherTabSignal,
      }),
    );
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: storageKey,
        newValue: otherTabSignal,
      }),
    );
    expect(onChange).toHaveBeenCalledOnce();
    unsubscribe();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: storageKey,
        newValue: JSON.stringify({
          event: 'changed',
          generation: 'later-generation',
          sender: 'other-tab',
        }),
      }),
    );
    expect(onChange).toHaveBeenCalledOnce();
  });
});
