import { HttpResponse, http } from 'msw';

// Contract-valid people, workspaces and runs shared by the Home, Runs and
// run page tests.

export const fixtureIds = {
  user: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspace: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflow: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  version: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  firstRun: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  secondRun: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  replayRun: '11111111-1111-4111-8111-111111111111',
} as const;

export const fixtureTimestamp = '2026-09-15T10:00:00.000Z';

/** The first find on a page also waits for its lazy chunk to load. */
export const coldStart = { timeout: 5_000 } as const;
export const apiBase = `http://pertexo.test/v1/workspaces/${fixtureIds.workspace}`;

export function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export const fixtureUser = {
  id: fixtureIds.user,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  createdAt: fixtureTimestamp,
  updatedAt: fixtureTimestamp,
};

export function fixtureWorkspace(capabilities: readonly string[]) {
  return {
    id: fixtureIds.workspace,
    name: 'Control Operations',
    slug: 'control-operations',
    status: 'active',
    revision: 1,
    role: 'operator',
    capabilities,
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
  };
}

export type RunFixtureStatus =
  'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'outcome_unknown';

export function fixtureRun(
  id: string,
  status: RunFixtureStatus,
  overrides: Record<string, unknown> = {},
) {
  const active =
    status === 'queued' || status === 'running' || status === 'waiting';
  return {
    id,
    workspaceId: fixtureIds.workspace,
    workflowId: fixtureIds.workflow,
    workflowVersionId: fixtureIds.version,
    workflowName: 'Customer onboarding',
    status,
    triggerType: 'manual',
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
    startedAt: status === 'queued' ? null : fixtureTimestamp,
    completedAt: active ? null : '2026-09-15T10:00:02.000Z',
    deadlineAt: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

export function fixtureWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: fixtureIds.workflow,
    workspaceId: fixtureIds.workspace,
    name: 'Customer onboarding',
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'active',
    publishedVersionId: fixtureIds.version,
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
    ...overrides,
  };
}

export function fixtureVersion(graph: unknown = emptyGraph) {
  return {
    id: fixtureIds.version,
    workflowId: fixtureIds.workflow,
    versionNumber: 7,
    schemaVersion: 1,
    graph,
    checksum: `wf:v1:sha256:${'a'.repeat(64)}`,
    publishedAt: fixtureTimestamp,
  };
}

export const emptyGraph = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  settings: {},
};

export function identityHandlers(capabilities: readonly string[]) {
  return [
    http.get('http://pertexo.test/v1/users/me', () =>
      HttpResponse.json(fixtureUser),
    ),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [fixtureWorkspace(capabilities)],
        nextCursor: null,
      }),
    ),
  ];
}

export function sseEvents(events: readonly Readonly<{ type: string }>[]) {
  return events
    .map((event, index) => {
      const body = {
        sequence: index + 1,
        createdAt: fixtureTimestamp,
        payload: { schemaVersion: 1 },
        ...event,
      };
      return `id: ${String(body.sequence)}\nevent: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`;
    })
    .join('');
}

export function notFoundProblem() {
  return HttpResponse.json(
    {
      type: 'urn:pertexo:problem:resource.not_found',
      title: 'Resource not found',
      status: 404,
      code: 'resource.not_found',
      requestId: 'request-not-found',
    },
    { status: 404, headers: { 'content-type': 'application/problem+json' } },
  );
}
