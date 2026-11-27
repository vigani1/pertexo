import type { Page } from '../../support/fixtures';
import {
  editorUrl,
  workflowId,
  workspaceId,
} from '../../workflow-editor/support';
import { installPolishRoutes } from '../polish-layout-fixture';
import {
  connectionUsage,
  connections,
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
  ready?: (page: Page) => Promise<void>;
}>;

const root = `/w/${workspaceId}`;
const hub = editorUrl.replace(/\/$/u, '');

export const workspaceScreens: readonly Screen[] = [
  { name: 'triggers', path: `${hub}/triggers` },
  { name: 'versions', path: `${hub}/versions` },
  { name: 'workflow-settings', path: `${hub}/settings` },
  { name: 'connections', path: `${root}/connections` },
  { name: 'tables', path: `${root}/data-tables` },
  {
    name: 'table-detail',
    path: `${root}/data-tables/${tables[0]?.id ?? ''}`,
  },
  { name: 'team', path: `${root}/team` },
  { name: 'settings', path: `${root}/settings` },
  { name: 'usage', path: `${root}/settings/usage` },
  { name: 'alerts', path: `${root}/settings/alerts` },
  { name: 'audit', path: `${root}/settings/audit` },
  { name: 'account', path: `${root}/account` },
  { name: 'notifications', path: `${root}/settings/notifications` },
  { name: 'api-tokens', path: `${root}/settings/api-tokens` },
  { name: 'promotion', path: `${root}/settings/promotion` },
  { name: 'sso', path: `${root}/settings/sso` },
  { name: 'workspaces', path: '/workspaces' },
  { name: 'not-found', path: `${root}/nowhere` },
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
