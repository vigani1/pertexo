import type { Locator, Page } from '@playwright/test';
import {
  editorUrl,
  user,
  workflowId,
  workspaceId,
} from '../../workflow-editor/support';
import { installPolishRoutes } from '../polish-layout-fixture';
import {
  connectionUsage,
  connections,
  invitations,
  members,
  tableQuotas,
  tableRows,
  tables,
} from './workspace-data';
import {
  liveVersionId,
  nextRuns,
  schedules,
  versions,
  webhooks,
  workflowSummary,
} from './workflow-data';

type Screen = Readonly<{
  name: string;
  path: string;
  /** What shows once the page's reads have answered. */
  ready: (page: Page) => Locator;
  /** Pages shown before anyone signs in. */
  signedOut?: boolean;
}>;

const root = `/w/${workspaceId}`;
const hub = editorUrl.replace(/\/$/u, '');
const heading = (name: string | RegExp) => (page: Page) =>
  page.getByRole('heading', { name }).first();

export const workspaceScreens: readonly Screen[] = [
  {
    name: 'triggers',
    path: `${hub}/triggers`,
    ready: (page) => page.getByRole('article', { name: 'By hand' }),
  },
  {
    name: 'versions',
    path: `${hub}/versions`,
    ready: (page) => page.getByRole('navigation', { name: 'Versions' }),
  },
  {
    name: 'workflow-settings',
    path: `${hub}/settings`,
    ready: heading('Danger zone'),
  },
  {
    name: 'connections',
    path: `${root}/connections`,
    ready: (page) => page.getByRole('list', { name: 'Connections' }),
  },
  {
    name: 'tables',
    path: `${root}/data-tables`,
    ready: (page) => page.getByRole('navigation', { name: 'Tables' }),
  },
  {
    name: 'table-detail',
    path: `${root}/data-tables/${tables[0]?.id ?? ''}`,
    ready: heading('Restock thresholds'),
  },
  {
    name: 'team',
    path: `${root}/team`,
    ready: (page) => page.getByRole('list', { name: 'Builders' }),
  },
  {
    name: 'settings',
    path: `${root}/settings`,
    ready: heading('How it’s known'),
  },
  {
    name: 'usage',
    path: `${root}/settings/usage`,
    ready: heading('By workflow'),
  },
  { name: 'alerts', path: `${root}/settings/alerts`, ready: heading('Alerts') },
  {
    name: 'audit',
    path: `${root}/settings/audit`,
    ready: heading('Audit log'),
  },
  { name: 'account', path: `${root}/account`, ready: heading('Account') },
  {
    name: 'notifications',
    path: `${root}/settings/notifications`,
    ready: heading('Notifications'),
  },
  {
    name: 'api-tokens',
    path: `${root}/settings/api-tokens`,
    ready: heading('API tokens'),
  },
  {
    name: 'promotion',
    path: `${root}/settings/promotion`,
    ready: heading('Promotion'),
  },
  { name: 'sso', path: `${root}/settings/sso`, ready: heading(/sign-on/u) },
];

const workflowApi = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`;

export async function installWorkspaceRoutes(page: Page) {
  await installPolishRoutes(page);
  await installWorkflowTabRoutes(page);
  await installWorkspaceDataRoutes(page);
}

const workspaceApi = `**/v1/workspaces/${workspaceId}`;

async function installWorkspaceDataRoutes(page: Page) {
  await page.route(`${workspaceApi}/data-tables`, (route) =>
    route.fulfill({ json: { tables, quotas: tableQuotas } }),
  );
  await page.route(`${workspaceApi}/data-tables/*/rows/query`, (route) =>
    route.fulfill({ json: tableRows }),
  );
  await page.route(`${workspaceApi}/assistant`, (route) =>
    route.fulfill({ json: { selection: null } }),
  );
  await page.route(`${workspaceApi}/members?**`, (route) =>
    route.fulfill({ json: members(user.id) }),
  );
  await page.route(`${workspaceApi}/invitations?**`, (route) =>
    route.fulfill({ json: invitations }),
  );
  await page.route(`${workspaceApi}/connections?**`, (route) =>
    route.fulfill({ json: { items: connections, nextCursor: null } }),
  );
  await page.route(`${workspaceApi}/connections/*`, (route) =>
    route.fulfill({
      json:
        connections.find((item) => route.request().url().endsWith(item.id)) ??
        connections[0],
    }),
  );
  await page.route(`${workspaceApi}/connections/*/usage?**`, (route) =>
    route.fulfill({ json: connectionUsage }),
  );
}

async function installWorkflowTabRoutes(page: Page) {
  await page.route(`**/v1/workspaces/${workspaceId}/auto-pause`, (route) =>
    route.fulfill({ json: { threshold: 10, revision: 1 } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/notifications/summary`,
    (route) => route.fulfill({ json: { unreadCount: 3, revision: '3' } }),
  );
  await page.route(workflowApi, (route) =>
    route.fulfill({ json: workflowSummary }),
  );
  await page.route(`${workflowApi}?**`, (route) =>
    route.fulfill({ json: { ...workflowSummary, templateOrigin: null } }),
  );
  await page.route(`${workflowApi}/versions?**`, (route) =>
    route.fulfill({ json: { items: versions, nextCursor: null } }),
  );
  await page.route(`${workflowApi}/triggers`, (route) =>
    route.fulfill({ json: webhooks }),
  );
  await page.route(`${workflowApi}/triggers/schedules`, (route) =>
    route.fulfill({ json: schedules }),
  );
  await page.route(`${workflowApi}/triggers/*/schedule/next-runs?**`, (route) =>
    route.fulfill({ json: nextRuns(route.request().url()) }),
  );
  await page.route(
    `${workflowApi}/triggers/*/schedule/occurrences?**`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`${workflowApi}/mcp`, (route) =>
    route.fulfill({
      json: {
        publishedVersionId: liveVersionId,
        eligible: true,
        exposure: null,
      },
    }),
  );
  await page.route(`${workflowApi}/failure-notification-policy`, (route) =>
    route.fulfill({ json: { destination: null } }),
  );
  await page.route(`${workflowApi}/triggers/*/webhook/deliveries?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
}
