import { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';
import type {
  PreviewRunRecord,
  WorkflowDraftRecord,
} from '@pertexo/database/testing';

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
    schemaVersion: 1,
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
    schemaVersion: 1,
    graphJson: httpNodeTestingGraph(),
    compatibility: {
      compatible: true,
      fingerprint: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.fingerprint,
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
