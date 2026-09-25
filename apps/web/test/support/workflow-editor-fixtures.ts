import { HttpResponse, http } from 'msw';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { fireEvent, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

// Shared, contract-valid fixtures for the workflow editor's component tests.

export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const editorPath = `/w/${workspaceId}/workflows/${workflowId}`;
export const etagA = `"draft-v1.${'a'.repeat(43)}"`;
export const etagB = `"draft-v1.${'b'.repeat(43)}"`;
export const api = 'http://pertexo.test/v1';
export const workflowApi = `${api}/workspaces/${workspaceId}/workflows/${workflowId}`;

export const release = {
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
};
export const compatibility = {
  compatible: true,
  fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
  issues: [],
};
export const user = {
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  status: 'active',
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
export const otherUser = {
  ...user,
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
export const emptyGraph: WorkflowGraphContract = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  settings: {},
};

export const setDefinition = {
  schemaVersion: 1,
  definition: { key: 'core.set', version: 1 },
  family: 'transform',
  configVersion: 1,
  configSchema: {
    type: 'object',
    properties: { value: { type: 'string', title: 'Value' } },
  },
  inputSchema: {},
  outputSchema: {},
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: [],
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: [],
  lifecycle: 'active',
  available: true,
  publishable: true,
} satisfies NodeDefinitionCatalogItem;
/** The Set step with no configurable fields, for pure graph and save tests. */
export const bareSetDefinition = {
  ...setDefinition,
  configSchema: { type: 'object', properties: {} },
} satisfies NodeDefinitionCatalogItem;
export const manualDefinition = {
  ...setDefinition,
  definition: { key: 'core.manual', version: 1 },
  family: 'trigger',
  configSchema: { type: 'object', properties: {} },
  outputSchema: {
    type: 'object',
    properties: { customer: { type: 'string' } },
    additionalProperties: true,
  },
  ports: { inputs: [], outputs: ['out'] },
} satisfies NodeDefinitionCatalogItem;
export const mappingDefinition = {
  ...setDefinition,
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
} satisfies NodeDefinitionCatalogItem;
export const numericDefinition = {
  ...setDefinition,
  configSchema: {
    type: 'object',
    required: ['requiredCount'],
    properties: {
      value: { type: 'string', title: 'Value' },
      count: { type: 'number', title: 'Count' },
      requiredCount: { type: 'integer', title: 'Required count' },
      enabled: { type: 'boolean', title: 'Enabled' },
      mode: { type: 'string', title: 'Mode', enum: ['safe', 'fast'] },
    },
  },
} satisfies NodeDefinitionCatalogItem;

interface SaveBody {
  graph: WorkflowGraphContract;
}

/** The routes every editor render needs, with a draft that saves as rev 2. */
export function editorHandlers(
  onSave: (request: Request, body: SaveBody) => void,
  options: Readonly<{
    graph?: WorkflowGraphContract;
    definitions?: readonly NodeDefinitionCatalogItem[];
    capabilities?: readonly string[];
  }> = {},
) {
  const initialGraph = options.graph ?? emptyGraph;
  const definitions = options.definitions ?? [setDefinition];
  const scoped = {
    ...workspace,
    capabilities: options.capabilities ?? workspace.capabilities,
  };
  return [
    http.get(`${api}/users/me`, () => HttpResponse.json(user)),
    http.get(`${api}/workspaces`, () =>
      HttpResponse.json({ items: [scoped], nextCursor: null }),
    ),
    http.get(`${api}/node-definitions`, () =>
      HttpResponse.json({ schemaVersion: 1, release, items: definitions }),
    ),
    http.get(`${api}/integrations`, () =>
      HttpResponse.json({ schemaVersion: 1, release, items: [] }),
    ),
    http.get(`${api}/workspaces/${workspaceId}/connections`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get(`${workflowApi}/draft`, () =>
      HttpResponse.json(draftBody(initialGraph, 1), {
        headers: { etag: etagA },
      }),
    ),
    http.put(`${workflowApi}/draft`, async ({ request }) => {
      const body: unknown = await request.clone().json();
      if (!isSaveBody(body)) return HttpResponse.json({}, { status: 400 });
      onSave(request, body);
      return HttpResponse.json(draftBody(body.graph, 2), {
        headers: { etag: etagB },
      });
    }),
  ];
}

export function draftBody(graph: WorkflowGraphContract, revision: number) {
  return {
    workflowId,
    revision,
    schemaVersion: 1,
    graph,
    compatibility,
    updatedAt: '2026-09-14T10:01:00.000Z',
  };
}

export function validHandler(onValidate: () => void = () => undefined) {
  return http.post(`${workflowApi}/validate`, () => {
    onValidate();
    return HttpResponse.json({ valid: true, issues: [], compatibility });
  });
}

export function versionBody(
  id: string,
  graph: WorkflowGraphContract,
  versionNumber = 1,
) {
  return {
    id,
    workflowId,
    versionNumber,
    schemaVersion: 1,
    graph,
    checksum: `wf:v1:sha256:${'b'.repeat(64)}`,
    publishedAt: '2026-09-14T10:02:00.000Z',
  };
}

export function runSummary(
  runId: string,
  workflowVersionId: string,
  status: 'queued' | 'succeeded',
) {
  return {
    id: runId,
    workspaceId,
    workflowId,
    workflowVersionId,
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

export function graphWithNumericConfig(
  config: WorkflowGraphContract['nodes'][number]['config'],
): WorkflowGraphContract {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        definition: { key: 'core.set', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config,
        inputMappings: {},
        connectionRefs: {},
        label: 'Numbers',
      },
    ],
    edges: [],
    settings: {},
  };
}

/** One Set step: enough for Publish, which an empty draft keeps disabled. */
export const oneStepGraph = graphWithNumericConfig({});

export function graphWithMappingNodes(
  inputMappings: WorkflowGraphContract['nodes'][number]['inputMappings'] = {},
): WorkflowGraphContract {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
        label: 'Manual input',
      },
      {
        id: 'target',
        definition: { key: 'core.set', version: 1 },
        position: { x: 340, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings,
        connectionRefs: {},
        label: 'Target',
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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/** The canvas once the lazy editor route has loaded. */
export async function findCanvas() {
  return within(await screen.findByRole('application', {}, { timeout: 4_000 }));
}

/** ⌘S: flush the draft save now. */
export function pressSave() {
  fireEvent.keyDown(window, { key: 's', metaKey: true });
}

/** Opens a Base UI select by its label and picks an option. */
export async function choose(event: UserEvent, label: string, option: string) {
  await event.click(screen.getByLabelText(label));
  await event.click(await screen.findByRole('option', { name: option }));
}

/** A notification's action button, not the command bar's control. */
export function toastAction(name: string) {
  const action = screen
    .getAllByRole('button', { name })
    .find((button) => button.closest('header') === null);
  if (action === undefined) throw new Error(`No notification action ${name}`);
  return action;
}

/** The add-step item for a step, found by its human name. */
export function addStepButton(name: RegExp) {
  return within(
    screen.getByRole('complementary', { name: 'Add a step' }),
  ).getByRole('button', { name });
}

export const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const runApi = `${api}/workspaces/${workspaceId}/runs/${runId}`;

/** Run ▾ → Run with input… */
export async function openRunLens(event: UserEvent) {
  await event.click(await screen.findByRole('button', { name: 'Run' }));
  await event.click(
    await screen.findByRole('menuitem', { name: 'Run with input…' }),
  );
}

/** Opens the issues lens from its chip and asks for a fresh check. */
export async function checkNow(event: UserEvent) {
  await event.click(
    screen.getByRole('button', { name: /Not checked yet|No issues|issue/u }),
  );
  await event.click(await screen.findByRole('button', { name: 'Check again' }));
}

export function findPaused() {
  return screen.findByRole('heading', { name: 'Editor paused' });
}

/** `/users/me` answering with whoever `current` says, or a network error. */
export function identityHandler(current: () => typeof user | 'error') {
  return http.get(`${api}/users/me`, () => {
    const identity = current();
    return identity === 'error'
      ? HttpResponse.error()
      : HttpResponse.json(identity);
  });
}

/** Enough of the run page for navigation after a run is accepted. */
export function runDetailHandlers() {
  return [
    http.get(runApi, () =>
      HttpResponse.json({
        run: runSummary(runId, versionId, 'queued'),
        nodes: [],
      }),
    ),
    http.get(
      `${runApi}/events`,
      () =>
        new HttpResponse('', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
  ];
}

export function workflowSummaryHandler(
  name: string,
  publishedVersionId: string | null,
) {
  return http.get(workflowApi, () =>
    HttpResponse.json({
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
    }),
  );
}

function isSaveBody(value: unknown): value is SaveBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'graph' in value &&
    typeof Reflect.get(value, 'graph') === 'object'
  );
}
