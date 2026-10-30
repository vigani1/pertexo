import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { useMatchRoute, type LinkProps } from '@tanstack/react-router';
import { WORKSPACE_PLACES, canOpenPlace } from './places';

type WorkspacePath = Extract<
  LinkProps['to'],
  | '/w/$workspaceId/workflows'
  | '/w/$workspaceId/data-tables'
  | '/w/$workspaceId/runs'
  | '/w/$workspaceId/inbox'
  | '/w/$workspaceId/requests'
  | '/w/$workspaceId/approvals'
  | '/w/$workspaceId/connections'
  | '/w/$workspaceId/team'
  | '/w/$workspaceId/settings'
>;

export type SpineDestination = Readonly<{
  to: WorkspacePath;
  label: string;
  icon: ReactNode;
  capability?: AccessibleWorkspace['capabilities'][number];
  exact?: boolean;
  /** Other pages that belong to this destination, so it stays lit there. */
  includes?: readonly WorkspacePath[];
  badge?: number;
  /** Says what the badge counts, for its accessible name: "running". */
  badgeNoun?: string;
}>;

/**
 * Which destinations the current role may see, in spine order. The spine
 * holds the work; workspace administration lives behind Settings, whose own
 * rail lists its pages.
 */
export function spineDestinations(
  workspace: AccessibleWorkspace,
  liveRunCount: number | undefined,
  unreadNoticeCount: number | undefined,
): Readonly<{
  primary: readonly SpineDestination[];
  workspace: readonly SpineDestination[];
}> {
  const open = (destination: SpineDestination) =>
    canOpenPlace(workspace, destination);
  const primary: readonly SpineDestination[] = [
    WORKSPACE_PLACES.workflows,
    { ...WORKSPACE_PLACES.runs, ...badge(liveRunCount, 'running') },
    {
      ...WORKSPACE_PLACES.inbox,
      ...(canOpenPlace(workspace, WORKSPACE_PLACES.runs)
        ? {
            includes: ['/w/$workspaceId/requests', '/w/$workspaceId/approvals'],
          }
        : {}),
      ...badge(unreadNoticeCount, 'unread'),
    },
    WORKSPACE_PLACES.dataTables,
    WORKSPACE_PLACES.connections,
  ];
  const administration: readonly SpineDestination[] = [
    WORKSPACE_PLACES.team,
    WORKSPACE_PLACES.settings,
  ];
  return {
    primary: primary.filter(open),
    workspace: administration.filter(open),
  };
}

function badge(count: number | undefined, badgeNoun: string) {
  return count === undefined || count === 0 ? {} : { badge: count, badgeNoun };
}

/** Whether the open page is one the destination includes, like Requests in Inbox. */
export function useIncludedPage(
  workspaceId: string,
  destination: SpineDestination,
): boolean {
  const matchRoute = useMatchRoute();
  return (destination.includes ?? []).some((to) =>
    Boolean(matchRoute({ to, params: { workspaceId }, fuzzy: true })),
  );
}
