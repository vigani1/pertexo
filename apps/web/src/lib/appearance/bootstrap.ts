export type AppearancePreference = 'system' | 'light' | 'dark';
export type AppearanceSnapshot = Readonly<{
  preference: AppearancePreference;
  theme: 'light' | 'dark';
  persistent: boolean;
}>;

declare global {
  interface Window {
    pertexoAppearance?: Readonly<{
      getSnapshot: () => AppearanceSnapshot;
      subscribe: (listener: () => void) => () => void;
      setPreference: (value: AppearancePreference) => void;
    }>;
  }
}

/** Self-contained: Vite embeds this same function before first paint. */
export function initializeAppearance(): void {
  if (window.pertexoAppearance !== undefined) return;
  const key = 'pertexo.appearance';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const listeners = new Set<() => void>();
  const parse = (value: string | null): AppearancePreference =>
    value === 'light' || value === 'dark' ? value : 'system';
  let persistent = true;
  const read = (): AppearancePreference => {
    try {
      return parse(window.localStorage.getItem(key));
    } catch {
      persistent = false;
      return 'system';
    }
  };
  let preference = read();
  const theme = (): 'light' | 'dark' => {
    if (preference === 'system') {
      if (system.matches) {
        return 'dark';
      }
      return 'light';
    }
    return preference;
  };
  let snapshot: AppearanceSnapshot = { preference, theme: theme(), persistent };
  const apply = () => {
    const resolved = theme();
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.classList.toggle('dark', resolved === 'dark');
    root.style.colorScheme = resolved;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', getComputedStyle(root).backgroundColor);
    if (
      snapshot.preference === preference &&
      snapshot.theme === resolved &&
      snapshot.persistent === persistent
    )
      return;
    snapshot = { preference, theme: resolved, persistent };
    for (const listener of listeners) listener();
  };
  window.pertexoAppearance = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPreference: (value) => {
      preference = value;
      try {
        window.localStorage.setItem(key, value);
        persistent = true;
      } catch {
        persistent = false;
      }
      apply();
    },
  };
  system.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    preference = read();
    apply();
  });
  apply();
}
