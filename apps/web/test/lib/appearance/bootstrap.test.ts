import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeAppearance } from '../../../src/lib/appearance/bootstrap';

function browser(stored: string | null = null, dark = false) {
  const values = new Map<string, string>();
  if (stored !== null) values.set('pertexo.appearance', stored);
  const events = new EventTarget();
  const media = Object.assign(new EventTarget(), { matches: dark });
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  vi.stubGlobal('window', {
    matchMedia: () => media,
    localStorage: storage,
    addEventListener: events.addEventListener.bind(events),
  });
  const open = () => {
    initializeAppearance();
    const owner = window.pertexoAppearance;
    if (owner === undefined) throw new Error('Missing appearance owner');
    return owner;
  };
  return { values, events, media, storage, open };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove('dark');
  document.documentElement.style.removeProperty('color-scheme');
});

describe('browser appearance', () => {
  it.each([null, 'invalid', 'system'])(
    'defaults %s to live system appearance',
    (stored) => {
      const { open, media } = browser(stored);
      const owner = open();
      expect(owner.getSnapshot()).toEqual({
        preference: 'system',
        theme: 'light',
        persistent: true,
      });
      const notify = vi.fn();
      owner.subscribe(notify);
      media.matches = true;
      media.dispatchEvent(new Event('change'));
      expect(owner.getSnapshot().theme).toBe('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.documentElement.style.colorScheme).toBe('dark');
      expect(notify).toHaveBeenCalledOnce();
    },
  );
  it.each(['light', 'dark'] as const)(
    'keeps explicit %s independent of the system',
    (choice) => {
      const { open, media, storage } = browser(choice);
      const owner = open();
      media.matches = !media.matches;
      media.dispatchEvent(new Event('change'));
      expect(owner.getSnapshot().theme).toBe(choice);
      owner.setPreference('system');
      expect(storage.setItem).toHaveBeenCalledWith(
        'pertexo.appearance',
        'system',
      );
      expect(owner.getSnapshot().theme).toBe('dark');
    },
  );
  it('synchronizes changed and cleared storage across tabs', () => {
    const { open, values, events } = browser('dark');
    const owner = open();
    values.set('pertexo.appearance', 'light');
    events.dispatchEvent(
      new StorageEvent('storage', { key: 'pertexo.appearance' }),
    );
    expect(owner.getSnapshot().preference).toBe('light');
    values.clear();
    events.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(owner.getSnapshot().preference).toBe('system');
  });
  it('keeps a usable in-memory choice when reading or writing storage is blocked', () => {
    const { open, storage } = browser();
    storage.getItem.mockImplementation(() => {
      throw new Error('blocked');
    });
    storage.setItem.mockImplementation(() => {
      throw new Error('blocked');
    });
    const owner = open();
    owner.setPreference('dark');
    expect(owner.getSnapshot()).toEqual({
      preference: 'dark',
      theme: 'dark',
      persistent: false,
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
  it('installs once and keeps snapshots stable until a real change', () => {
    const { open } = browser('dark');
    const owner = open();
    const snapshot = owner.getSnapshot();
    const notify = vi.fn();
    const unsubscribe = owner.subscribe(notify);
    expect(open()).toBe(owner);
    owner.setPreference('dark');
    expect(owner.getSnapshot()).toBe(snapshot);
    expect(notify).not.toHaveBeenCalled();
    unsubscribe();
    owner.setPreference('light');
    expect(notify).not.toHaveBeenCalled();
  });
});
