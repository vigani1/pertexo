import { holdsCapability } from '@/features/workspaces/availability.public';
import { parsePromotionSearch } from '@/features/workflow-promotions/search.public';
import { parseFederationSearch } from '@/features/federation/search.public';
import { parseAuditSearch } from '@/features/governance/search.public';
import { parseUsageTrendsSearch } from '@/features/usage/search.public';
import { createRoute } from '@tanstack/react-router';
import { lazyRoute } from '@/components/patterns/app-update/lazy';

import { pageTitle } from '../../root/page-title';
import { parseUsageSearch } from '@/features/usage/search.public';
import { warmPrefetches } from '../../root/route-context';
import { workspaceShellRoute } from '../routes';

/** Pathless layout: every Settings page beside the Settings rail. */
export const settingsHubRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  id: 'settings-hub',
  component: lazyRoute(() => import('./hub'), 'SettingsHubRoute'),
});

export const alertsRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/alerts',
  staticData: { crumb: 'Alerts' },
  loader: async ({ context }) => {
    const [
      { connectionDiscoveryQueryOptions },
      { failureNotificationDestinationsQueryOptions },
    ] = await Promise.all([
      import('@/features/connections/queries.public'),
      import('@/features/failure-notifications/queries.public'),
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
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Alerts', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../alerts'), 'AlertsRoute'),
});

export const workspaceSettingsRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings',
  staticData: { crumb: 'Settings' },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Settings', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../settings'), 'WorkspaceSettingsRoute'),
});

export const usageTrendsRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/usage/trends',
  staticData: { crumb: 'Trends' },
  validateSearch: parseUsageTrendsSearch,
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Trends', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../usage-trends'), 'UsageTrendsRoute'),
});

export const usageRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/usage',
  staticData: { crumb: 'Usage' },
  validateSearch: parseUsageSearch,
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Usage', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../usage'), 'UsageRoute'),
});

export const federationSettingsRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/sso',
  staticData: { crumb: 'Single sign-on' },
  validateSearch: parseFederationSearch,
  head: ({ match }) => ({
    meta: [
      { title: pageTitle('Single sign-on', match.context.workspace.name) },
    ],
  }),
  component: lazyRoute(() => import('./sso'), 'FederationSettingsRoute'),
});

export const auditRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/audit',
  staticData: { crumb: 'Audit log' },
  validateSearch: parseAuditSearch,
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Audit log', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../audit'), 'AuditRoute'),
});

export const workspaceVariablesRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/variables',
  staticData: { crumb: 'Variables' },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Variables', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../variables'), 'WorkspaceVariablesRoute'),
});

export const apiTokensRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/api-tokens',
  staticData: { crumb: 'API tokens' },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('API tokens', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('../api-tokens'), 'ApiTokensRoute'),
});

export const notificationPreferencesRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/notifications',
  staticData: { crumb: 'Notifications' },
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Notifications', match.context.workspace.name) }],
  }),
  component: lazyRoute(
    () => import('./notifications'),
    'NotificationPreferencesRoute',
  ),
});

export const workflowPromotionRoute = createRoute({
  getParentRoute: () => settingsHubRoute,
  path: 'settings/promotion',
  staticData: { crumb: 'Promotion' },
  validateSearch: parsePromotionSearch,
  head: ({ match }) => ({
    meta: [{ title: pageTitle('Promotion', match.context.workspace.name) }],
  }),
  component: lazyRoute(() => import('./promotion'), 'WorkflowPromotionRoute'),
});
