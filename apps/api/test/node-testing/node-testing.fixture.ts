import { vi } from 'vitest';
import type { WorkflowStepSampleStore } from '@pertexo/core/authoring';
import type {
  PreviewRunRecord,
  WorkflowDraftRecord,
} from '@pertexo/core/testing';

export const nodeTestingIds = Object.freeze({
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  connectionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  previewRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
});

export const nodeTestingAcceptedAt = new Date('2026-08-22T20:00:00.000Z');
export const nodeTestingExpiresAt = new Date('2026-08-29T20:00:00.000Z');

export function httpNodeTestingGraph() {
  return {
    nodes: [
      {
        id: 'http',
        definition: { key: 'http.request', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {
          method: 'POST',
          url: 'https://provider.example.test/resource',
          headers: {},
          timeoutMillis: 1_000,
          maxRedirects: 1,
          maxResponseBytes: 1_024,
          inlineResponseBytes: 512,
        },
        inputMappings: {
          body: { kind: 'run_input', path: '$.body' },
        },
        connectionRefs: { http_headers: nodeTestingIds.connectionId },
      },
    ],
    edges: [],
    settings: {},
  } as const;
}

export function nodeTestingDraft(
  overrides: Partial<WorkflowDraftRecord> = {},
): WorkflowDraftRecord {
  return {
    workflowId: nodeTestingIds.workflowId,
    workspaceId: nodeTestingIds.workspaceId,
    revision: 3,
    graphJson: httpNodeTestingGraph(),
    compatibility: {
      compatible: true,
      fingerprint: `wf-compat:sha256:${'c'.repeat(64)}`,
      issues: [],
    },
    updatedBy: nodeTestingIds.actorId,
    updatedAt: new Date('2026-08-22T19:00:00.000Z'),
    ...overrides,
  };
}

export function nodeTestingPreview(
  overrides: Partial<PreviewRunRecord> = {},
): PreviewRunRecord {
  return {
    id: nodeTestingIds.previewRunId,
    workspaceId: nodeTestingIds.workspaceId,
    workflowId: nodeTestingIds.workflowId,
    draftRevision: 3,
    nodeId: 'http',
    status: 'queued',
    sideEffectClass: 'unsafe',
    mayContactProvider: true,
    mayCauseExternalSideEffect: true,
    dryRun: 'not_supported',
    output: null,
    safeErrorCode: null,
    createdAt: nodeTestingAcceptedAt,
    startedAt: null,
    completedAt: null,
    expiresAt: nodeTestingExpiresAt,
    ...overrides,
  };
}

export function nodeTestingSamples(): WorkflowStepSampleStore {
  return {
    get: vi
      .fn()
      .mockResolvedValue({ sample: null, output: null, draftRevision: 3 }),
    list: vi.fn().mockResolvedValue({ items: [], draftRevision: 3 }),
    put: vi.fn().mockRejectedValue(new Error('Unexpected sample write')),
    remove: vi.fn().mockRejectedValue(new Error('Unexpected sample removal')),
  };
}

/** What `NodeTestingModule.register` needs, with a builder signed in and nothing stored. */
export function nodeTestingDependencies() {
  const evaluate = vi.fn().mockResolvedValue({
    kind: 'value',
    value: { encoding: 'utf8', value: 'evaluated' },
    canonicalBytes: 39,
  });
  return {
    authorization: {
      findAccess: vi.fn().mockResolvedValue({
        actorId: nodeTestingIds.actorId,
        workspaceId: nodeTestingIds.workspaceId,
        role: 'builder' as const,
        membershipStatus: 'active' as const,
        workspaceStatus: 'active' as const,
      }),
    },
    persistence: {
      workflowTestSuites: {
        prepare: vi.fn(),
        start: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        report: vi.fn(),
        cancel: vi.fn(),
      },
      workflowTests: {
        prepare: vi.fn(),
        start: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        cancel: vi.fn(),
      },
      stepSamples: nodeTestingSamples(),
      getDraft: vi.fn().mockResolvedValue(nodeTestingDraft()),
      acceptPreview: vi.fn().mockResolvedValue({
        acceptedAt: nodeTestingAcceptedAt,
        duplicate: false,
        expiresAt: nodeTestingExpiresAt,
        outboxEventId: '11111111-1111-4111-8111-111111111111',
        previewAttemptId: '22222222-2222-4222-8222-222222222222',
        previewRunId: nodeTestingIds.previewRunId,
        status: 'queued' as const,
      }),
      resolvePreviewReplay: vi.fn().mockResolvedValue(null),
      readPreview: vi.fn().mockResolvedValue(null),
    },
    expressionEvaluator: { evaluate },
  };
}
