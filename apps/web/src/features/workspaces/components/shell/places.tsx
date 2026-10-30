import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { LinkProps } from '@tanstack/react-router';
import {
  BellIcon,
  GaugeIcon,
  HomeIcon,
  InboxIcon,
  KeyRoundIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  Table2Icon,
  UsersIcon,
  WavesIcon,
  WorkflowIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

type Capability = AccessibleWorkspace['capabilities'][number];

type Place = Readonly<{
  to: LinkProps['to'];
  label: string;
  icon?: ReactNode;
  /** What a role needs to open it; a place without one is open to everyone. */
  capability?: Capability;
}>;

/** One row per page: the spine, the settings rail and the palette all read it. */
export const WORKSPACE_PLACES = {
  home: { to: '/w/$workspaceId', label: 'Home', icon: <HomeIcon /> },
  workflows: {
    to: '/w/$workspaceId/workflows',
    label: 'Workflows',
    icon: <WorkflowIcon />,
  },
  runs: {
    to: '/w/$workspaceId/runs',
    label: 'Runs',
    icon: <WavesIcon />,
    capability: 'run:read',
  },
  inbox: {
    to: '/w/$workspaceId/inbox',
    label: 'Inbox',
    icon: <InboxIcon />,
    capability: 'workspace:read',
  },
  dataTables: {
    to: '/w/$workspaceId/data-tables',
    label: 'Data tables',
    icon: <Table2Icon />,
    capability: 'workspace:read',
  },
  connections: {
    to: '/w/$workspaceId/connections',
    label: 'Connections',
    icon: <PlugIcon />,
    capability: 'connection:read',
  },
  team: {
    to: '/w/$workspaceId/team',
    label: 'Team',
    icon: <UsersIcon />,
    capability: 'member:read',
  },
  settings: {
    to: '/w/$workspaceId/settings',
    label: 'Settings',
    icon: <SlidersHorizontalIcon />,
  },
  usage: {
    to: '/w/$workspaceId/settings/usage',
    label: 'Usage',
    icon: <GaugeIcon />,
    capability: 'run:read',
  },
  variables: { to: '/w/$workspaceId/settings/variables', label: 'Variables' },
  alerts: {
    to: '/w/$workspaceId/settings/alerts',
    label: 'Alerts',
    icon: <BellIcon />,
    capability: 'workflow:update',
  },
  promotion: {
    to: '/w/$workspaceId/settings/promotion',
    label: 'Promotion',
    capability: 'workflow:update',
  },
  audit: {
    to: '/w/$workspaceId/settings/audit',
    label: 'Audit log',
    capability: 'audit:read',
  },
  sso: {
    to: '/w/$workspaceId/settings/sso',
    label: 'Single sign-on',
    capability: 'member:read',
  },
  notifications: {
    to: '/w/$workspaceId/settings/notifications',
    label: 'Notifications',
  },
  apiTokens: {
    to: '/w/$workspaceId/settings/api-tokens',
    label: 'API tokens',
    icon: <KeyRoundIcon />,
  },
} as const satisfies Readonly<Record<string, Place>>;

export function canOpenPlace(
  workspace: AccessibleWorkspace,
  place: Pick<Place, 'capability'>,
): boolean {
  return (
    place.capability === undefined ||
    workspace.capabilities.includes(place.capability)
  );
}
