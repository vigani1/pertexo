import type { AccessibleWorkspace } from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';
import {
  apiBase,
  fixtureIds,
  fixtureRun,
  fixtureVersion,
  identityHandlers,
  sseEvents,
} from '../../../../support/fixtures/run';
import { mockServer } from '../../../../support/mock-server';
export const {
  workspace: workspaceId,
  workflow: workflowId,
  firstRun: runId,
} = fixtureIds;

export const artifactId = '55555555-5555-4555-8555-555555555555';

export const capabilities: AccessibleWorkspace['capabilities'] = [
  'workspace:read',
  'workflow:read',
  'run:read',
  'run:cancel',
  'connection:read',
  'artifact:read',
];

export function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1_000).toISOString();
}

const graph = {
  nodes: [
    {
      id: 'send-receipt',
      label: 'Send receipt',
      definition: { key: 'email.send_message', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
  ],
  edges: [],
  settings: {},
};

export function node(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    nodeId: 'send-receipt',
    invocationKey: 'send-receipt:0',
    status,
    currentAttemptNumber: 1,
    startedAt: secondsAgo(45),
    completedAt: null,
    resumeAt: null,
    safeErrorCode: null,
    ...overrides,
  };
}

export function stepEvent(type: string, secondsBack: number, payload = {}) {
  return {
    type,
    createdAt: secondsAgo(secondsBack),
    payload: {
      nodeId: 'send-receipt',
      invocationKey: 'send-receipt:0',
      ...payload,
    },
  };
}

export function installRun({
  run,
  nodes,
  events,
  stream,
  input = { kind: 'none' },
  output = { kind: 'none' },
}: Readonly<{
  run: ReturnType<typeof fixtureRun>;
  nodes: readonly unknown[];
  events?: readonly Readonly<{ type: string }>[];
  stream?: () => Response;
  input?: unknown;
  output?: unknown;
}>) {
  let streams = 0;
  mockServer.use(
    ...identityHandlers(capabilities),
    http.get(`${apiBase}/runs/${runId}/input`, () =>
      HttpResponse.json({ input }),
    ),
    http.get(`${apiBase}/runs/${runId}/node-runs/:nodeRunId/output`, () =>
      HttpResponse.json({ output }),
    ),
    http.get(`${apiBase}/runs/${runId}/node-runs/:nodeRunId/input`, () =>
      HttpResponse.json({ input: { kind: 'none' } }),
    ),
    http.get(`${apiBase}/runs/${runId}`, () =>
      HttpResponse.json({ run, nodes }),
    ),
    http.get(`${apiBase}/runs/${runId}/events`, () => {
      streams += 1;
      return (
        stream?.() ??
        new HttpResponse(sseEvents(events ?? []), {
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    }),
    http.get(`${apiBase}/workflows/${workflowId}/versions`, () =>
      HttpResponse.json({ items: [fixtureVersion(graph)], nextCursor: null }),
    ),
    http.get(`${apiBase}/runs`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
  return { streamCount: () => streams };
}

export const retryingRun = () =>
  fixtureRun(runId, 'running', {
    startedAt: secondsAgo(47),
    createdAt: secondsAgo(47),
  });

export const retryEvents = () => [
  stepEvent('node.started', 45, { attemptNumber: 1 }),
  stepEvent('node.retry_scheduled', 44, {
    attemptNumber: 1,
    dueAt: secondsAgo(-60),
    safeErrorCode: 'provider.unavailable',
  }),
];

export function emulatePhoneScreen() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query === '(max-width: 47.999rem)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}
