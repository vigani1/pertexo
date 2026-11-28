import type { Page } from '@playwright/test';
import { workflowId, workspaceId } from '../../workflow-editor/support';

// Complete, contract-valid answers for the workflow tabs' screenshots.

export const liveVersionId = '30000000-0000-4000-8000-000000000003';
const hour = 3_600_000;
const at = (offsetHours: number) =>
  new Date(Date.now() + offsetHours * hour).toISOString();

function node(id: string, key: string, label: string, x: number) {
  return {
    id,
    definition: { key, version: 1 },
    position: { x, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    label,
  };
}

const steps = [
  node('webhook-node', 'core.webhook', 'New invoice', 0),
  node('schedule-node', 'core.schedule', 'Sweep the invoice inbox', 0),
  node('weekly-node', 'core.schedule', 'Weekly summary', 0),
  node('form-node', 'core.form', 'Submit an invoice', 0),
  node('extract', 'core.set', 'Read the invoice', 300),
  node('approve', 'core.set', 'Finance approval', 600),
  node('post', 'core.set', 'Post to ERP', 900),
];

function graph(nodes: readonly unknown[]) {
  return { nodes, edges: [], settings: {} };
}

const people = {
  dena: {
    id: '40000000-0000-4000-8000-000000000001',
    displayName: 'Dena Okafor',
  },
  arjun: {
    id: '40000000-0000-4000-8000-000000000002',
    displayName: 'Arjun Mehta',
  },
};

function version(
  number: number,
  nodes: readonly unknown[],
  publishedAt: string,
  publishedBy: { id: string; displayName: string },
) {
  return {
    id: `30000000-0000-4000-8000-00000000000${String(number)}`,
    workflowId,
    versionNumber: number,
    graph: graph(nodes),
    graphDigest: String(number).repeat(64),
    checksum: `wf:sha256:${'9c1e44ab07f2'.repeat(5)}${'a'.repeat(4)}`,
    publishedAt,
    publishedBy,
  };
}

const versions = [
  version(3, steps, at(-46), people.dena),
  version(
    2,
    steps.filter((step) => step.id !== 'approve'),
    at(-24 * 18),
    people.arjun,
  ),
  version(
    1,
    steps.filter((step) => step.id !== 'approve' && step.id !== 'post'),
    at(-24 * 25),
    people.dena,
  ),
];

export const workflowSummary = {
  workflow: {
    id: workflowId,
    workspaceId,
    name: 'Invoice intake',
    nameRevision: 1,
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'active',
    webhookSetupRequired: false,
    publishedVersionId: liveVersionId,
    createdAt: at(-24 * 30),
    updatedAt: at(-2),
  },
};

const webhooks = {
  items: [
    {
      id: '50000000-0000-4000-8000-000000000001',
      workflowId,
      workflowVersionId: liveVersionId,
      nodeId: 'webhook-node',
      kind: 'webhook',
      status: 'active',
      healthStatus: 'healthy',
      lastErrorCode: null,
      authentication: { mode: 'signed', allowedOrigins: [] },
      endpointReady: true,
      reconciledAt: at(-0.5),
    },
  ],
};

function schedule({
  id,
  nodeId,
  recurrence,
  next,
  last,
}: Readonly<{
  id: string;
  nodeId: string;
  recurrence: unknown;
  next: string;
  last: string | null;
}>) {
  return {
    id,
    workflowId,
    workflowVersionId: liveVersionId,
    nodeId,
    kind: 'schedule',
    status: 'active',
    healthStatus: 'healthy',
    lastErrorCode: null,
    reconciledAt: at(-1),
    recurrence,
    misfirePolicy: 'skip',
    nextFireAt: next,
    lastFireAt: last,
  };
}

const schedules = {
  items: [
    schedule({
      id: '50000000-0000-4000-8000-000000000002',
      nodeId: 'schedule-node',
      recurrence: {
        kind: 'cron',
        expression: '0 7 * * 1-5',
        timezone: 'Europe/Berlin',
      },
      next: at(16.5),
      last: at(-7.5),
    }),
    schedule({
      id: '50000000-0000-4000-8000-000000000003',
      nodeId: 'weekly-node',
      recurrence: { kind: 'interval', intervalMinutes: 360 },
      next: at(3.2),
      last: at(-2.8),
    }),
  ],
};

function nextRuns(url: string) {
  const first = url.includes('000000000002') ? 16.5 : 3.2;
  const step = url.includes('000000000002') ? 24 : 6;
  return {
    observedAt: at(0),
    items: [0, 1, 2].map((index) => ({
      scheduledAt: at(first + index * step),
    })),
  };
}

const workflowApi = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`;

export async function installWorkflowTabRoutes(
  page: Page,
  triggers: 'all' | 'without-form' | 'manual-only' = 'all',
) {
  const replacementSteps =
    triggers === 'manual-only'
      ? [
          node('manual-node', 'core.manual', 'Manual input', 0),
          ...steps.filter((step) => step.definition.key === 'core.set'),
        ]
      : steps.filter((step) => step.definition.key !== 'core.form');
  const listedVersions =
    triggers === 'all'
      ? versions
      : versions.map((item) => ({ ...item, graph: graph(replacementSteps) }));
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
  await page.route(`${workflowApi}/versions/*`, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const version = listedVersions.find((item) => item.id === id);
    return route.fulfill(
      version === undefined ? { status: 404 } : { json: version },
    );
  });
  await page.route(`${workflowApi}/versions?**`, (route) =>
    route.fulfill({ json: { items: listedVersions, nextCursor: null } }),
  );
  await page.route(`${workflowApi}/triggers`, (route) =>
    route.fulfill({
      json: triggers === 'manual-only' ? { items: [] } : webhooks,
    }),
  );
  await page.route(`${workflowApi}/triggers/schedules`, (route) =>
    route.fulfill({
      json: triggers === 'manual-only' ? { items: [] } : schedules,
    }),
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
