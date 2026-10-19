import { lazy, type ComponentType } from 'react';
import { lazyRouteComponent } from '@tanstack/react-router';
import { AppUpdatedNotice, AppUpdatedPage } from './notice';

// How each browser rejects an import whose file is gone, and how Vite
// rejects one whose stylesheet is. A deployment replaces every hashed
// chunk, so an open tab meets these on its next lazy load.
const CHUNK_FAILURES = [
  'Failed to fetch dynamically imported module', // Chromium
  'error loading dynamically imported module', // Firefox
  'Importing a module script failed', // Safari
  'Unable to preload CSS for', // Vite
] as const;

/** A lazy chunk couldn't load: the app was most likely updated. */
export function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    CHUNK_FAILURES.some((start) => error.message.startsWith(start))
  );
}

/**
 * A piece of a page that loads on first render. If its chunk is gone it
 * renders `Updated` in its place (the inline notice unless a dialog needs a
 * dialog), so the rest of the page, an editor's unsaved draft included, stays
 * mounted. Any other failure still reaches the error boundary.
 */
export function lazyPiece<Props>(
  load: () => Promise<ComponentType<Props>>,
  Updated: ComponentType<Props> = AppUpdatedNotice,
) {
  return lazy(() =>
    load().then(
      (component) => ({ default: component }),
      (error: unknown) => {
        if (!isChunkLoadError(error)) throw error;
        return { default: Updated };
      },
    ),
  );
}

/**
 * A route's component, preloaded on intent like `lazyRouteComponent`. A gone
 * chunk renders the update page where the route would be, and never reloads
 * by itself: TanStack's own reload could drop unsaved work, or hang the page
 * if the person declines the browser's leave prompt.
 */
export function lazyRoute<TModule, TKey extends keyof TModule>(
  importer: () => Promise<TModule>,
  exportName: TKey,
) {
  return lazyRouteComponent(
    () =>
      importer().then(
        (module) => ({ page: module[exportName] }),
        (error: unknown) => {
          if (!isChunkLoadError(error)) throw error;
          return { page: AppUpdatedPage };
        },
      ),
    'page',
  );
}
