import { expect, type BrowserContext, type Page } from '@playwright/test';

// Controlled HTTP fixtures shared by the workflow editor journeys.

export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const editorUrl = `/w/${workspaceId}/workflows/${workflowId}`;
const csrfToken = 'csrf-token-for-editor-tests-123456789012345678901234';
export const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
export const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  revision: 1,
  role: 'owner',
  capabilities: [
    'workspace:read',
    'workflow:read',
    'workflow:update',
    'workflow:publish',
    'run:read',
    'run:start',
    'run:cancel',
    'connection:read',
  ],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
const release = {
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
};
export const definition = {
  schemaVersion: 1,
  definition: { key: 'core.set', version: 1 },
  family: 'transform',
  configVersion: 1,
  configSchema: {
    type: 'object',
    properties: {
      value: { type: 'string', title: 'Value' },
      count: { type: 'number', title: 'Count' },
    },
  },
  inputSchema: {
    type: 'object',
    properties: {
      customer: { type: 'string', title: 'Customer' },
      requestedBy: { type: 'string', title: 'Requested by' },
      active: { type: 'boolean', title: 'Active' },
    },
    additionalProperties: true,
  },
  outputSchema: { type: 'object', additionalProperties: true },
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: [],
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: [],
  lifecycle: 'active',
  available: true,
  publishable: true,
};
export const manualDefinition = {
  ...definition,
  definition: { key: 'core.manual', version: 1 },
  family: 'trigger',
  configSchema: { type: 'object', properties: {} },
  inputSchema: {},
  ports: { inputs: [], outputs: ['out'] },
};

export type Graph = Readonly<{
  schemaVersion: number;
  nodes: readonly unknown[];
  edges: readonly unknown[];
  settings: Readonly<Record<string, unknown>>;
}>;

export interface RemoteDraft {
  graph: Graph;
  revision: number;
}

export function remoteDraft(graph: Graph = emptyGraph()): RemoteDraft {
  return { graph, revision: 1 };
}

export function emptyGraph(): Graph {
  return { schemaVersion: 1, nodes: [], edges: [], settings: {} };
}

export async function installEditorRoutes(
  page: Page,
  remote: RemoteDraft,
  options: Readonly<{
    accessibleWorkspace?: typeof workspace;
    definitions?: readonly unknown[];
    workflowName?: string;
  }> = {},
) {
  const accessibleWorkspace = options.accessibleWorkspace ?? workspace;
  const definitions = options.definitions ?? [definition];
  await page.route('**/v1/users/me', (route) => route.fulfill({ json: user }));
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({ json: { items: [accessibleWorkspace], nextCursor: null } }),
  );
  await page.route('**/v1/node-definitions', (route) =>
    route.fulfill({ json: { schemaVersion: 1, release, items: definitions } }),
  );
  await page.route('**/v1/integrations', (route) =>
    route.fulfill({ json: { schemaVersion: 1, release, items: [] } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) =>
      route.fulfill({
        json: workflowSummary(options.workflowName ?? 'Customer onboarding'),
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
    (route) =>
      route.fulfill({
        json: { valid: true, issues: [], compatibility: compatibility() },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
    (route) => serveDraft(route, remote),
  );
}

async function serveDraft(
  route: Parameters<Parameters<Page['route']>[1]>[0],
  remote: RemoteDraft,
) {
  const request = route.request();
  if (request.method() === 'GET') {
    await route.fulfill({
      headers: {
        'content-type': 'application/json',
        etag: currentEtag(remote),
      },
      body: JSON.stringify(draftBody(remote)),
    });
    return;
  }
  expect(request.method()).toBe('PUT');
  expect(request.headers()['x-csrf-token']).toBe(csrfToken);
  if (request.headers()['if-match'] !== currentEtag(remote)) {
    await route.fulfill({
      status: 412,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'urn:pertexo:problem:workflow.revision_conflict',
        title: 'Workflow revision conflict',
        status: 412,
        code: 'workflow.revision_conflict',
        requestId: 'request-editor-conflict',
        currentRevision: remote.revision,
        currentEtag: currentEtag(remote),
      }),
    });
    return;
  }
  const body = parseGraphRequest(request.postData());
  if (body === null) {
    await route.fulfill({ status: 400, json: {} });
    return;
  }
  remote.graph = body.graph;
  remote.revision += 1;
  await route.fulfill({
    headers: { 'content-type': 'application/json', etag: currentEtag(remote) },
    body: JSON.stringify(draftBody(remote)),
  });
}

export function workflowSummary(
  name: string,
  publishedVersionId: string | null = null,
) {
  return {
    workflow: {
      id: workflowId,
      workspaceId,
      name,
      lifecycleStatus: 'active',
      lifecycleRevision: 1,
      activationStatus: publishedVersionId === null ? 'inactive' : 'active',
      publishedVersionId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  };
}

export function compatibility() {
  return {
    compatible: true,
    fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
    issues: [],
  };
}

export function draftBody(remote: RemoteDraft) {
  return {
    workflowId,
    revision: remote.revision,
    schemaVersion: 1,
    graph: remote.graph,
    compatibility: compatibility(),
    updatedAt: '2026-09-14T10:00:00.000Z',
  };
}

export function editorNode(
  id: string,
  label: string,
  value: string,
  x: number,
) {
  return {
    id,
    label,
    definition: { key: 'core.set', version: 1 },
    position: { x, y: 80 },
    configVersion: 1,
    config: { value },
    inputMappings: {},
    connectionRefs: {},
  };
}

export function mappingGraph(): Graph {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'manual',
        label: 'Manual input',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'target',
        label: 'Target',
        definition: { key: 'core.set', version: 1 },
        position: { x: 380, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-target',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'target', port: 'in' },
      },
    ],
    settings: {},
  };
}

export async function addCsrfCookie(context: BrowserContext) {
  await context.addCookies([
    { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
  ]);
}

/** A distinct opaque tag per revision, so stale tabs always conflict. */
export function currentEtag(remote: RemoteDraft): string {
  const suffix = String(remote.revision);
  return `"draft-v1.${'r'.repeat(43 - suffix.length)}${suffix}"`;
}

export function runSummary(
  runId: string,
  versionId: string,
  status: 'queued' | 'running' | 'succeeded',
) {
  return {
    id: runId,
    workspaceId,
    workflowId,
    workflowVersionId: versionId,
    status,
    triggerType: 'manual',
    createdAt: '2026-09-14T10:02:00.000Z',
    updatedAt: '2026-09-14T10:03:00.000Z',
    startedAt: '2026-09-14T10:02:01.000Z',
    completedAt: status === 'succeeded' ? '2026-09-14T10:03:00.000Z' : null,
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

/** The add-step lens item for a step, by its human name. */
export function addStep(page: Page, name: RegExp) {
  return page
    .getByRole('complementary', { name: 'Add a step' })
    .getByRole('button', { name });
}

/** Whether the page asks before unloading (a dirty editor does). */
export function blocksUnload(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

function parseGraphRequest(value: string | null): { graph: Graph } | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || !('graph' in parsed))
      return null;
    const graph: unknown = Reflect.get(parsed, 'graph');
    return isGraph(graph) ? { graph } : null;
  } catch {
    return null;
  }
}

function isGraph(value: unknown): value is Graph {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray(Reflect.get(value, 'nodes')) &&
    Array.isArray(Reflect.get(value, 'edges'))
  );
}
