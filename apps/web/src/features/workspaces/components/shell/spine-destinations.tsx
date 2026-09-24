import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { LinkProps } from '@tanstack/react-router';
import {
  BellIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  WavesIcon,
  WorkflowIcon,
} from 'lucide-react';

export type SpineDestination = Readonly<{
  to: Extract<
    LinkProps['to'],
    | '/w/$workspaceId'
    | '/w/$workspaceId/workflows'
    | '/w/$workspaceId/runs'
    | '/w/$workspaceId/connections'
    | '/w/$workspaceId/team'
    | '/w/$workspaceId/alerts'
    | '/w/$workspaceId/settings'
  >;
  label: string;
  icon: ReactNode;
  exact?: boolean;
  badge?: number;
}>;

/** Which destinations the current role may see, in spine order. */
export function spineDestinations(
  workspace: AccessibleWorkspace,
  liveRunCount: number | undefined,
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
        : { badge: liveRunCount }),
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
  if (can('workflow:update'))
    administration.push({
      to: '/w/$workspaceId/alerts',
      label: 'Alerts',
      icon: <BellIcon />,
    });
  administration.push({
    to: '/w/$workspaceId/settings',
    label: 'Settings',
    icon: <SlidersHorizontalIcon />,
  });
  return { primary, workspace: administration };
}
