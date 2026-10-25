import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import {
  workflowSummaryResponseSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';
import { oneStepGraph } from './editor-graph';
import { createUserFixture, createWorkspaceFixture } from './identity';
export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const editorPath = `/w/${workspaceId}/workflows/${workflowId}`;

export const etagA = `"draft.${'a'.repeat(43)}"`;

export const etagB = `"draft.${'b'.repeat(43)}"`;

export const api = 'http://pertexo.test/v1';

export const workflowApi = `${api}/workspaces/${workspaceId}/workflows/${workflowId}`;

export const compatibility = {
  compatible: true,
  fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
  issues: [],
};

export const user = createUserFixture({
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
});

export const otherUser = {
  ...user,
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

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

export const emptyGraph: WorkflowGraphContract = {
  nodes: [],
  edges: [],
  settings: {},
};

export const setDefinition = {
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
} satisfies NodeDefinitionCatalogItem;

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
    http.get(`${workflowApi}/draft/tests`, () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get(`${workflowApi}/draft/samples`, () =>
      HttpResponse.json({
        items: [],
        draftRevision: 1,
        limits: { inlineBytes: 262144, depth: 64, members: 10000 },
      }),
    ),
    http.get(`${workflowApi}/draft/nodes/:nodeId/sample`, () =>
      HttpResponse.json({
        sample: null,
        output: null,
        draftRevision: 1,
        limits: { inlineBytes: 262144, depth: 64, members: 10000 },
      }),
    ),
    http.get(`${api}/users/me`, () => HttpResponse.json(user)),
    http.get(`${api}/workspaces`, () =>
      HttpResponse.json({ items: [scoped], nextCursor: null }),
    ),
    workflowSummaryHandler('Test workflow', null),
    http.get(`${workflowApi}/input-cases`, () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get(`${api}/node-definitions`, () =>
      HttpResponse.json({ items: definitions }),
    ),
    http.get(`${api}/integrations`, () => HttpResponse.json({ items: [] })),
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
    graph,
    compatibility,
    updatedAt: '2026-09-14T10:01:00.000Z',
  };
}

export function validHandler(
  onValidate: () => void = () => undefined,
  etag = etagB,
) {
  return http.post(`${workflowApi}/validate`, () => {
    onValidate();
    return HttpResponse.json(
      { valid: true, currentPublication: null, issues: [], compatibility },
      { headers: { etag } },
    );
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
    graph,
    checksum: `wf:sha256:${'b'.repeat(64)}`,
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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const runApi = `${api}/workspaces/${workspaceId}/runs/${runId}`;

export function identityHandler(current: () => typeof user | 'error') {
  return http.get(`${api}/users/me`, () => {
    const identity = current();
    return identity === 'error'
      ? HttpResponse.error()
      : HttpResponse.json(identity);
  });
}

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
    HttpResponse.json(
      workflowSummaryResponseSchema.parse({
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
      }),
    ),
  );
}

export function publishedWorkflowHandlers(
  graph: WorkflowGraphContract = oneStepGraph,
) {
  return [
    workflowSummaryHandler('Test workflow', versionId),
    http.get(`${workflowApi}/versions`, () =>
      HttpResponse.json({
        items: [versionBody(versionId, graph)],
        nextCursor: null,
      }),
    ),
  ];
}

function isSaveBody(value: unknown): value is SaveBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'graph' in value &&
    typeof Reflect.get(value, 'graph') === 'object'
  );
}
