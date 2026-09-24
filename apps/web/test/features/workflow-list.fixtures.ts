import { HttpResponse, http } from 'msw';
import type { NodeDefinitionListResponse } from '@pertexo/contracts/schemas/catalog';

// Contract-valid fixtures shared by the workflow list and New workflow tests.

export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const secondWorkflowId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const thirdWorkflowId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const versionId = '12121212-1212-4121-8121-121212121212';
export const etag = `"draft-v1.${'a'.repeat(43)}"`;
export const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;

const release = {
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
};

export const user = {
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  status: 'active',
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

export function workspaceWith(capabilities: readonly string[]) {
  return {
    id: workspaceId,
    name: 'Control Operations',
    slug: 'control-operations',
    status: 'active',
    revision: 1,
    role: 'owner',
    capabilities: ['workspace:read', 'workflow:read', ...capabilities],
    createdAt: '2026-09-14T10:00:00.000Z',
    updatedAt: '2026-09-14T10:00:00.000Z',
  };
}

export function summary(
  id: string,
  name: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    id,
    workspaceId,
    name,
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'inactive',
    publishedVersionId: null,
    createdAt: '2026-09-14T10:00:00.000Z',
    updatedAt: '2026-09-14T10:00:00.000Z',
    ...overrides,
  };
}

type Step = Readonly<{ id: string; key: string; label?: string; x: number }>;

export function graphOf(steps: readonly Step[]) {
  return {
    schemaVersion: 1,
    nodes: steps.map((step) => ({
      id: step.id,
      definition: { key: step.key, version: 1 },
      position: { x: step.x, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
      ...(step.label === undefined ? {} : { label: step.label }),
    })),
    edges: steps.slice(1).map((step, index) => ({
      id: `edge-${step.id}`,
      source: { nodeId: steps[index]?.id ?? step.id, port: 'out' },
      target: { nodeId: step.id, port: 'in' },
    })),
    settings: {},
  };
}

export const emptyGraph = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  settings: {},
};

export function draftBody(id: string, graph: unknown = emptyGraph) {
  return {
    workflowId: id,
    revision: 1,
    schemaVersion: 1,
    graph,
    compatibility: {
      compatible: true,
      fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
      issues: [],
    },
    updatedAt: '2026-09-14T10:00:00.000Z',
  };
}

export function createdResponse(id: string, name: string) {
  return HttpResponse.json(
    { workflow: summary(id, name), draft: draftBody(id) },
    { status: 201, headers: { etag } },
  );
}

/** Identity, catalog and connection reads every workflows page makes. */
export function discoveryHandlers(
  capabilities: readonly string[] = ['workflow:create', 'connection:read'],
) {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [workspaceWith(capabilities)],
        nextCursor: null,
      }),
    ),
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json({ schemaVersion: 1, release, items: [] }),
    ),
    http.get('http://pertexo.test/v1/integrations', () =>
      HttpResponse.json({ schemaVersion: 1, release, items: [] }),
    ),
    http.get(`${api}/connections`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  ];
}

/** Every row reads its draft for its shape; unknown IDs get an empty graph. */
export function draftHandler(graphs: Readonly<Record<string, unknown>> = {}) {
  return http.get(`${api}/workflows/:id/draft`, ({ params }) => {
    const id = String(params.id);
    return HttpResponse.json(draftBody(id, graphs[id] ?? emptyGraph), {
      headers: { etag },
    });
  });
}

export function problem(status: number, code: string) {
  return HttpResponse.json(
    {
      type: `urn:pertexo:problem:${code}`,
      title: 'Problem',
      status,
      code,
      requestId: `request-${code}`,
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

type CatalogItem = NodeDefinitionListResponse['items'][number];

export function catalogDefinition(
  key: string,
  family: CatalogItem['family'],
  flags: Readonly<{
    available?: boolean;
    publishable?: boolean;
    version?: number;
  }> = {},
): CatalogItem {
  return {
    schemaVersion: 1,
    definition: { key, version: flags.version ?? 1 },
    family,
    configVersion: flags.version ?? 1,
    configSchema: {},
    inputSchema: {},
    outputSchema: {},
    ports: { inputs: family === 'trigger' ? [] : ['in'], outputs: ['out'] },
    credentialRequirements: [],
    connectionRequirements: [],
    retryClass: 'safe',
    resourceClass: 'io',
    capabilities: [],
    lifecycle: 'active',
    available: flags.available ?? true,
    publishable: flags.publishable ?? true,
  };
}

export function catalogOf(
  items: readonly CatalogItem[],
): NodeDefinitionListResponse {
  return { schemaVersion: 1, release, items: [...items] };
}
