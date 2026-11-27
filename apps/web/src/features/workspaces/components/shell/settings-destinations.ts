import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { LinkProps } from '@tanstack/react-router';
import { WORKSPACE_PLACES, canOpenPlace } from './places';

export type SettingsDestination = Readonly<{
  to: Extract<
    LinkProps['to'],
    | '/w/$workspaceId/settings'
    | '/w/$workspaceId/settings/usage'
    | '/w/$workspaceId/settings/variables'
    | '/w/$workspaceId/settings/alerts'
    | '/w/$workspaceId/settings/promotion'
    | '/w/$workspaceId/settings/audit'
    | '/w/$workspaceId/settings/sso'
    | '/w/$workspaceId/settings/notifications'
    | '/w/$workspaceId/settings/api-tokens'
    | '/w/$workspaceId/account'
  >;
  label: string;
  capability?: AccessibleWorkspace['capabilities'][number];
  exact?: boolean;
}>;

export type SettingsGroup = Readonly<{
  label: string;
  destinations: readonly SettingsDestination[];
}>;

/**
 * The Settings pages this role may open: the workspace's everyday ones, then
 * your own, then the advanced ones most workspaces never need (promotion
 * between workspaces, the audit log, single sign-on), last and labelled so.
 */
export function settingsGroups(
  workspace: AccessibleWorkspace,
): readonly SettingsGroup[] {
  const allowed = (destinations: readonly SettingsDestination[]) =>
    destinations.filter((destination) => canOpenPlace(workspace, destination));
  const groups: SettingsGroup[] = [
    {
      label: 'Workspace',
      destinations: allowed([
        { ...WORKSPACE_PLACES.settings, label: 'General', exact: true },
        WORKSPACE_PLACES.usage,
        WORKSPACE_PLACES.variables,
        WORKSPACE_PLACES.alerts,
      ]),
    },
    {
      label: 'You',
      destinations: [
        WORKSPACE_PLACES.notifications,
        WORKSPACE_PLACES.apiTokens,
        { to: '/w/$workspaceId/account', label: 'Account' },
      ],
    },
    {
      label: 'Advanced',
      destinations: allowed([
        WORKSPACE_PLACES.promotion,
        WORKSPACE_PLACES.audit,
        WORKSPACE_PLACES.sso,
      ]),
    },
  ];
  return groups.filter((group) => group.destinations.length > 0);
}
