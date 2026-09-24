import type { NotFoundRouteProps } from '@tanstack/react-router';
import { NotFoundPage, WorkspaceUnavailablePage } from './system-pages';

/** Unmatched URLs and scopes the person can't open land here. */
export function RootNotFound({ data }: NotFoundRouteProps) {
  const kind: unknown =
    typeof data === 'object' && data !== null
      ? Reflect.get(data, 'kind')
      : undefined;
  return kind === 'workspace' ? <WorkspaceUnavailablePage /> : <NotFoundPage />;
}
