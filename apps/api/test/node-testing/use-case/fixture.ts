import { randomUUID } from 'node:crypto';
import type { JsonValue } from '@pertexo/workflow-model';

import type { AcceptedPreviewRun } from '@pertexo/core/testing';

import { vi } from 'vitest';

import { createActorContext } from '../../../src/authorization/index.js';
import type { NodeTestingPersistence } from '../../../src/node-testing/ports.js';
import {
  httpNodeTestingGraph,
  nodeTestingAcceptedAt,
  nodeTestingDraft,
  nodeTestingExpiresAt,
  nodeTestingIds,
  nodeTestingSamples,
} from '../fixture.js';

export const { actorId, workspaceId, workflowId, connectionId } =
  nodeTestingIds;

export const acceptedAt = nodeTestingAcceptedAt;

export const expiresAt = nodeTestingExpiresAt;

export const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  requestId: 'request-node-test',
});

export function graph() {
  return httpNodeTestingGraph();
}

export function graphWithConfig(config: Readonly<Record<string, JsonValue>>) {
  return {
    ...graph(),
    nodes: [
      {
        ...graph().nodes[0],
        config,
      },
    ],
  } as const;
}

export function emailGraph() {
  return {
    nodes: [
      {
        id: 'email',
        definition: { key: 'email.send_notification', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: { timeoutMillis: 10_000 },
        inputMappings: {
          toEmail: { kind: 'run_input', path: '$.toEmail' },
          subject: { kind: 'run_input', path: '$.subject' },
          text: { kind: 'run_input', path: '$.text' },
        },
        connectionRefs: { resend_api_key: connectionId },
      },
    ],
    edges: [],
    settings: {},
  } as const;
}

export function draft(overrides: Parameters<typeof nodeTestingDraft>[0] = {}) {
  return nodeTestingDraft(overrides);
}

export function accepted(): AcceptedPreviewRun {
  return {
    acceptedAt,
    duplicate: false,
    expiresAt,
    outboxEventId: randomUUID(),
    previewAttemptId: randomUUID(),
    previewRunId: randomUUID(),
    status: 'queued',
  };
}

type TestNodePersistence = Pick<
  NodeTestingPersistence,
  'acceptPreview' | 'getDraft' | 'resolvePreviewReplay' | 'stepSamples'
>;

export function persistence(overrides: Partial<TestNodePersistence> = {}) {
  return {
    stepSamples: nodeTestingSamples(),
    getDraft: vi.fn().mockResolvedValue(draft()),
    acceptPreview: vi.fn().mockResolvedValue(accepted()),
    resolvePreviewReplay: vi.fn().mockResolvedValue(null),
    ...overrides,
  } satisfies TestNodePersistence;
}

export function authorization() {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
  };
}

export function requestInput() {
  return {
    actor,
    routeWorkspaceId: workspaceId,
    workflowId,
    nodeId: 'http',
  } as const;
}
