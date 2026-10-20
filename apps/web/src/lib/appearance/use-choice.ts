import { useSyncExternalStore } from 'react';
import type { AppearancePreference, AppearanceSnapshot } from './bootstrap';

const fallback: AppearanceSnapshot = {
  preference: 'system',
  theme: 'dark',
  persistent: false,
};
const snapshot = () => window.pertexoAppearance?.getSnapshot() ?? fallback;
const subscribe = (listener: () => void) =>
  window.pertexoAppearance?.subscribe(listener) ?? (() => undefined);

export function useAppearance(): AppearanceSnapshot {
  return useSyncExternalStore(subscribe, snapshot, () => fallback);
}

export function setAppearance(value: AppearancePreference): void {
  window.pertexoAppearance?.setPreference(value);
}
