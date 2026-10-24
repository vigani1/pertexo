import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { useMatchRoute, type LinkProps } from '@tanstack/react-router';
import {
  Table2Icon,
  InboxIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  WavesIcon,
  WorkflowIcon,
} from 'lucide-react';

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
  const can = (capability: string) =>
    workspace.capabilities.includes(capability as never);
  const primary: SpineDestination[] = [
    {
      to: '/w/$workspaceId/workflows',
      label: 'Workflows',
      icon: <WorkflowIcon />,
    },
  ];
  if (can('run:read'))
    primary.push({
      to: '/w/$workspaceId/runs',
      label: 'Runs',
      icon: <WavesIcon />,
      ...(liveRunCount === undefined || liveRunCount === 0
        ? {}
        : { badge: liveRunCount, badgeNoun: 'running' }),
    });
  if (can('workspace:read'))
    primary.push({
      to: '/w/$workspaceId/inbox',
      label: 'Inbox',
      icon: <InboxIcon />,
      ...(can('run:read')
        ? {
            includes: ['/w/$workspaceId/requests', '/w/$workspaceId/approvals'],
          }
        : {}),
      ...(unreadNoticeCount === undefined || unreadNoticeCount === 0
        ? {}
        : { badge: unreadNoticeCount, badgeNoun: 'unread' }),
    });
  if (can('workspace:read'))
    primary.push({
      to: '/w/$workspaceId/data-tables',
      label: 'Data tables',
      icon: <Table2Icon />,
    });
  if (can('connection:read'))
    primary.push({
      to: '/w/$workspaceId/connections',
      label: 'Connections',
      icon: <PlugIcon />,
    });
  const administration: SpineDestination[] = [];
  if (can('member:read'))
    administration.push({
      to: '/w/$workspaceId/team',
      label: 'Team',
      icon: <UsersIcon />,
    });
  administration.push({
    to: '/w/$workspaceId/settings',
    label: 'Settings',
    icon: <SlidersHorizontalIcon />,
  });
  return { primary, workspace: administration };
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
