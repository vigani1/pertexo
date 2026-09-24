import { HttpResponse, http } from 'msw';
import { mockServer } from '../support/mock-server';
import {
  api,
  problem,
  user,
  userId,
  workspaceId,
  workspaceWith,
} from './workflow-list.fixtures';

// Contract-valid fixtures shared by the Triggers, Versions and Settings tabs.

export { api, problem, userId, workspaceId };
export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const secondWorkflowId = '99999999-9999-4999-8999-999999999999';
export const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const olderVersionId = '66666666-6666-4666-8666-666666666666';
export const scheduleId = '11111111-1111-4111-8111-111111111111';
export const webhookId = '22222222-2222-4222-8222-222222222222';
export const secondWebhookId = '55555555-5555-4555-8555-555555555555';
export const destinationId = '33333333-3333-4333-8333-333333333333';
export const connectionId = '44444444-4444-4444-8444-444444444444';
export const etag = `"draft-v1.${'a'.repeat(43)}"`;
export const etagB = `"draft-v1.${'b'.repeat(43)}"`;
export const etagC = `"draft-v1.${'c'.repeat(43)}"`;
export const workflowApi = `${api}/workflows/${workflowId}`;

/** Beyond reading the workspace and its workflows. */
export const defaultCapabilities = [
  'workflow:update',
  'workflow:publish',
  'connection:manage',
] as const;

export const emptyGraph = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  settings: {},
};

export const compatibility = {
  compatible: true,
  fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
  issues: [],
};

export const summary = {
  id: workflowId,
  workspaceId,
  name: 'Daily control',
  lifecycleStatus: 'active',
  lifecycleRevision: 7,
  activationStatus: 'active',
  publishedVersionId: versionId,
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

export const schedule = {
  id: scheduleId,
  workflowId,
  workflowVersionId: versionId,
  nodeId: 'schedule-node',
  kind: 'schedule',
  status: 'active',
  healthStatus: 'healthy',
  lastErrorCode: null,
  reconciledAt: '2026-09-14T10:00:00.000Z',
  recurrence: { kind: 'interval', intervalMinutes: 15 },
  misfirePolicy: 'skip',
  nextFireAt: '2026-09-14T10:15:00.000Z',
  lastFireAt: null,
};

export const webhook = {
  id: webhookId,
  workflowId,
  workflowVersionId: versionId,
  nodeId: 'webhook-node',
  kind: 'webhook',
  status: 'configuration_required',
  healthStatus: 'pending',
  lastErrorCode: null,
  endpointReady: false,
  reconciledAt: null,
};

export const secondWebhook = {
  ...webhook,
  id: secondWebhookId,
  nodeId: 'webhook-node-two',
};

export const destination = {
  id: destinationId,
  workspaceId,
  kind: 'email',
  status: 'enabled',
  currentVersion: 1,
  config: { kind: 'email', connectionId, toEmail: 'alerts@example.test' },
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

export function stepNode(id: string, key: string, label?: string) {
  return {
    id,
    definition: { key, version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    ...(label === undefined ? {} : { label }),
  };
}

/** The published graph behind the trigger fixtures, with named steps. */
export const publishedGraph = {
  ...emptyGraph,
  nodes: [
    stepNode('webhook-node', 'core.webhook', 'Receive order'),
    stepNode('schedule-node', 'core.schedule', 'Nightly check'),
  ],
};

export function version(
  id: string,
  versionNumber: number,
  graph: unknown = publishedGraph,
) {
  return {
    id,
    workflowId,
    versionNumber,
    schemaVersion: 1,
    graph,
    checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
    publishedAt: '2026-09-14T10:00:00.000Z',
  };
}

export function graphWithNode(label: string) {
  return {
    ...emptyGraph,
    nodes: [{ ...stepNode('node-a', 'core.set'), config: { value: label } }],
  };
}

export function draftResponse(currentGraph: unknown, currentEtag: string) {
  return HttpResponse.json(
    {
      workflowId,
      revision: currentEtag === etag ? 3 : currentEtag === etagB ? 4 : 5,
      schemaVersion: 1,
      graph: currentGraph,
      compatibility,
      updatedAt: '2026-09-14T10:01:00.000Z',
    },
    { headers: { etag: currentEtag } },
  );
}

/** Every read the three tabs make, answering with the fixtures above. */
export function installQueries(
  capabilities: readonly string[] = defaultCapabilities,
) {
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [workspaceWith(capabilities)],
        nextCursor: null,
      }),
    ),
    http.get(workflowApi, () => HttpResponse.json({ workflow: summary })),
    http.get(`${workflowApi}/versions`, () =>
      HttpResponse.json({
        items: [version(versionId, 1)],
        nextCursor: null,
      }),
    ),
    http.get(`${workflowApi}/triggers/schedules`, () =>
      HttpResponse.json({ items: [schedule] }),
    ),
    http.get(`${workflowApi}/triggers`, () =>
      HttpResponse.json({ items: [webhook] }),
    ),
    http.get(`${api}/failure-notification-destinations`, () =>
      HttpResponse.json({ items: [destination] }),
    ),
    http.get(`${api}/connections`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
}
