import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { LinkProps } from '@tanstack/react-router';

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
  >;
  label: string;
  exact?: boolean;
}>;

export type SettingsGroup = Readonly<{
  label: string;
  destinations: readonly SettingsDestination[];
}>;

/** The Settings pages this role may open: the workspace's, then your own. */
export function settingsGroups(
  workspace: AccessibleWorkspace,
): readonly SettingsGroup[] {
  const can = (capability: (typeof workspace.capabilities)[number]) =>
    workspace.capabilities.includes(capability);
  const shared: SettingsDestination[] = [
    { to: '/w/$workspaceId/settings', label: 'General', exact: true },
  ];
  if (can('run:read'))
    shared.push({ to: '/w/$workspaceId/settings/usage', label: 'Usage' });
  shared.push({ to: '/w/$workspaceId/settings/variables', label: 'Variables' });
  if (can('workflow:update'))
    shared.push(
      { to: '/w/$workspaceId/settings/alerts', label: 'Alerts' },
      { to: '/w/$workspaceId/settings/promotion', label: 'Promotion' },
    );
  if (can('audit:read'))
    shared.push({ to: '/w/$workspaceId/settings/audit', label: 'Audit log' });
  if (can('member:read'))
    shared.push({
      to: '/w/$workspaceId/settings/sso',
      label: 'Single sign-on',
    });
  return [
    { label: 'Workspace', destinations: shared },
    {
      label: 'You',
      destinations: [
        {
          to: '/w/$workspaceId/settings/notifications',
          label: 'Notifications',
        },
        { to: '/w/$workspaceId/settings/api-tokens', label: 'API tokens' },
      ],
    },
  ];
}
