import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../test/support/fixtures/identity';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { WorkflowNote } from '@pertexo/workflow-model';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { unpausedWorkflowSettings } from '../../test/support/fixtures/auto-pause';
import { defaultConcurrencySettings } from '../../test/support/fixtures/concurrency';
import {
  routeEmptyWorkflowOrganization,
  workflowListBody,
} from '../workflows/list-support';

// Controlled HTTP fixtures shared by the workflow editor journeys.

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const editorUrl = `/w/${workspaceId}/workflows/${workflowId}`;
const csrfToken = 'csrf-token-for-editor-tests-123456789012345678901234';
export const user = createUserFixture({
  id: userId,
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
});
export const workspace = createWorkspaceFixture({
  id: workspaceId,
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
});
export const definition = {
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
};
export const manualDefinition = {
  ...definition,
  definition: { key: 'core.manual', version: 1 },
  family: 'trigger',
  configSchema: { type: 'object', properties: {} },
  inputSchema: {},
  ports: { inputs: [], outputs: ['out'] },
};

/** Export, Input cases and Duplicate fold into ⋯ below 2xl. */
const FOLDED_WORKFLOW_ACTIONS = new Set([
  'Export…',
  'Input cases',
  'Duplicate…',
]);

/**
 * A workflow action is a header button on wide screens and a ⋯ menu item
 * below them: below 2xl for the workflow's own actions, and on phones for
 * the editor's controls such as the contract.
 */
export async function openWorkflowAction(page: Page, name: string) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width < (FOLDED_WORKFLOW_ACTIONS.has(name) ? 1536 : 640)) {
    await page
      .getByRole('button', { name: 'More workflow actions', exact: true })
      .click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  } else {
    await page.getByRole('button', { name, exact: true }).click();
  }
}

export type Graph = Readonly<{
  callable?: WorkflowGraphContract['callable'];
  notes?: readonly WorkflowNote[] | undefined;
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

function emptyGraph(): Graph {
  return { nodes: [], edges: [], settings: {} };
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
  await page.route('**/v1/workspaces/*/workflows/*/presence**', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { people: [] } });
    if (route.request().method() === 'PUT')
      return route.fulfill({ json: { accepted: true } });
    return route.fallback();
  });

  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/test-suites`,
    (route) =>
      route.fulfill({
        json: {
          current: {
            signature: '0'.repeat(64),
            draftRevision: remote.revision,
            variableSetRevision: null,
            samples: [],
            cases: [],
          },
          items: [],
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/tests`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/samples`,
    (route) =>
      route.fulfill({
        json: {
          items: [],
          draftRevision: remote.revision,
          limits: { inlineBytes: 262144, depth: 64, members: 10000 },
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/nodes/*/sample`,
    (route) =>
      route.fulfill({
        json: {
          sample: null,
          output: null,
          draftRevision: remote.revision,
          limits: { inlineBytes: 262144, depth: 64, members: 10000 },
        },
      }),
  );
  const accessibleWorkspace = options.accessibleWorkspace ?? workspace;
  const definitions = options.definitions ?? [definition];
  await page.route(
    `**/v1/workspaces/${workspaceId}/pending-tasks/audience/inspect`,
    (route) =>
      route.fulfill({
        json: { matchingMemberCount: 1, actorMatchesAudience: true },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/pending-tasks?**`,
    (route) =>
      route.fulfill({ json: { items: [], nextCursor: null, pendingCount: 0 } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/pending-tasks/audience?**`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/error-workflow`,
    (route) => route.fulfill({ json: { targetWorkflowId: null, revision: 1 } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/error-workflow/targets`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/concurrency`,
    (route) => route.fulfill({ json: defaultConcurrencySettings }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/auto-pause`,
    (route) => route.fulfill({ json: unpausedWorkflowSettings }),
  );
  await page.route('**/v1/users/me', (route) => route.fulfill({ json: user }));
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({ json: { items: [accessibleWorkspace], nextCursor: null } }),
  );
  await page.route('**/v1/node-definitions', (route) =>
    route.fulfill({ json: { items: definitions } }),
  );
  await page.route('**/v1/integrations', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await routeEmptyWorkflowOrganization(page, workspaceId);
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({ json: workflowListBody(route.request().url(), []) }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/input-cases?**`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) =>
      route.fulfill({
        json: workflowSummary(options.workflowName ?? 'Customer onboarding'),
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}?include=templateOrigin`,
    (route) =>
      route.fulfill({
        json: {
          ...workflowSummary(options.workflowName ?? 'Customer onboarding'),
          templateOrigin: null,
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/validate`,
    (route) =>
      route.fulfill({
        json: {
          valid: true,
          currentPublication: null,
          issues: [],
          compatibility: compatibility(),
        },
        headers: { etag: currentEtag(remote) },
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
      nameRevision: 1,
      lifecycleStatus: 'active',
      lifecycleRevision: 1,
      activationStatus: publishedVersionId === null ? 'inactive' : 'active',
      webhookSetupRequired: false,
      publishedVersionId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  };
}

function compatibility() {
  return {
    compatible: true,
    fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
    issues: [],
  };
}

function draftBody(remote: RemoteDraft) {
  return {
    workflowId,
    revision: remote.revision,
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
  await context.route('**/v1/workspaces/*/variables', (route) =>
    route.fulfill({ json: { revision: 0, values: {} } }),
  );
  await context.addCookies([
    { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
  ]);
}

/** A distinct opaque tag per revision, so stale tabs always conflict. */
export function currentEtag(remote: RemoteDraft): string {
  const suffix = String(remote.revision);
  return `"draft.${'r'.repeat(43 - suffix.length)}${suffix}"`;
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
