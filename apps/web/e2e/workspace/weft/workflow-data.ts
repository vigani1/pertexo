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

export const versions = [
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

export const webhooks = {
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

function schedule(
  id: string,
  nodeId: string,
  recurrence: unknown,
  next: string,
  last: string | null,
) {
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

export const schedules = {
  items: [
    schedule(
      '50000000-0000-4000-8000-000000000002',
      'schedule-node',
      {
        kind: 'cron',
        expression: '0 7 * * 1-5',
        timezone: 'Europe/Berlin',
      },
      at(16.5),
      at(-7.5),
    ),
    schedule(
      '50000000-0000-4000-8000-000000000003',
      'weekly-node',
      { kind: 'interval', intervalMinutes: 360 },
      at(3.2),
      at(-2.8),
    ),
  ],
};

export function nextRuns(url: string) {
  const first = url.includes('000000000002') ? 16.5 : 3.2;
  const step = url.includes('000000000002') ? 24 : 6;
  return {
    observedAt: at(0),
    items: [0, 1, 2].map((index) => ({
      scheduledAt: at(first + index * step),
    })),
  };
}
