import { workspacePage } from '../workspace-page';
import { holdsCapability } from '@/features/workspaces/availability.public';
import { parsePromotionSearch } from '@/features/workflow-promotions/workflow-promotions-search.public';
import { parseFederationSearch } from '@/features/federation/federation-search.public';
import { parseAuditSearch } from '@/features/governance/governance-search.public';
import { parseUsageTrendsSearch } from '@/features/usage/usage-search.public';
import { createRoute } from '@tanstack/react-router';
import { lazyRoute } from '@/components/patterns/app-update/lazy';

import { parseUsageSearch } from '@/features/usage/usage-search.public';
import { warmPrefetches } from '../../root/route-context';
import { workspaceShellRoute } from '../routes';
import { parseAlertsSearch } from '@/features/failure-notifications/failure-notifications-search.public';

/** Pathless layout: every Settings page beside the Settings rail. */
export const settingsHubRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  id: 'settings-hub',
  component: lazyRoute(() => import('./hub'), 'SettingsHubRoute'),
});

export const alertsRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/alerts',
  ...workspacePage('Alerts'),
  validateSearch: (search) => parseAlertsSearch(search),
  loader: async ({ context }) => {
    const [
      { connectionDiscoveryQueryOptions },
      { failureNotificationDestinationsQueryOptions },
    ] = await Promise.all([
      import('@/features/connections/connections-queries.public'),
      import('@/features/failure-notifications/failure-notifications-queries.public'),
    ]);

    const { apiClient, queryClient, user, workspace } = context;
    const can = (capability: (typeof workspace.capabilities)[number]) =>
      workspace.capabilities.includes(capability);
    if (!holdsCapability(workspace, 'workflow:update')) return;
    warmPrefetches(context, [
      queryClient.query(
        failureNotificationDestinationsQueryOptions(
          apiClient,
          user.id,
          workspace.id,
        ),
      ),
      ...(can('connection:manage') && can('connection:read')
        ? [
            queryClient.query(
              connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
            ),
          ]
        : []),
    ]);
  },

  component: lazyRoute(() => import('../alerts'), 'AlertsRoute'),
});

export const workspaceSettingsRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings',
  ...workspacePage('Settings'),

  component: lazyRoute(() => import('../settings'), 'WorkspaceSettingsRoute'),
});

export const usageTrendsRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/usage/trends',
  ...workspacePage('Trends'),
  validateSearch: parseUsageTrendsSearch,

  component: lazyRoute(() => import('../usage-trends'), 'UsageTrendsRoute'),
});

export const usageRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/usage',
  ...workspacePage('Usage'),
  validateSearch: parseUsageSearch,

  component: lazyRoute(() => import('../usage'), 'UsageRoute'),
});

export const federationSettingsRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/sso',
  ...workspacePage('Single sign-on'),
  validateSearch: parseFederationSearch,

  component: lazyRoute(() => import('./sso'), 'FederationSettingsRoute'),
});

export const auditRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/audit',
  ...workspacePage('Audit log'),
  validateSearch: parseAuditSearch,

  component: lazyRoute(() => import('../audit'), 'AuditRoute'),
});

export const workspaceVariablesRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/variables',
  ...workspacePage('Variables'),

  component: lazyRoute(() => import('../variables'), 'WorkspaceVariablesRoute'),
});

export const apiTokensRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/api-tokens',
  ...workspacePage('API tokens'),

  component: lazyRoute(() => import('../api-tokens'), 'ApiTokensRoute'),
});

export const notificationPreferencesRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/notifications',
  ...workspacePage('Notifications'),

  component: lazyRoute(
    () => import('./notifications'),
    'NotificationPreferencesRoute',
  ),
});

export const workflowPromotionRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/promotion',
  ...workspacePage('Promotion'),
  validateSearch: parsePromotionSearch,

  component: lazyRoute(() => import('./promotion'), 'WorkflowPromotionRoute'),
});
