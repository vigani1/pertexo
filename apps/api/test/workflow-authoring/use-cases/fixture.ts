import type { Role } from '@pertexo/workflow-model';
import { vi } from 'vitest';

import { createActorContext } from '../../../src/authorization/index.js';
import type { WorkflowAuthoringPersistence } from '../../../src/workflow-authoring/ports.js';
import type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from '@pertexo/core/testing';

import { validateWorkflowGraph } from '@pertexo/workflow-model';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const fingerprint =
  'wf-compat:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const graph = {
  nodes: [],
  edges: [],
  settings: {},
} as const;

export const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId,
  requestId: 'request-42',
});

export function draft(
  overrides: Partial<WorkflowDraftRecord> = {},
): WorkflowDraftRecord {
  return {
    workflowId,
    workspaceId,
    revision: 1,
    graphJson: graph,
    compatibility: { compatible: true, fingerprint, issues: [] },
    updatedBy: actorId,
    updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    ...overrides,
  };
}

export function workflow(): WorkflowRecord {
  return {
    id: workflowId,
    workspaceId,
    name: 'Operations',
    nameRevision: 1,
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'inactive',
    webhookSetupRequired: false,
    publishedVersionId: null,
    createdBy: actorId,
    createdAt: new Date('2026-08-20T12:00:00.000Z'),
    updatedAt: new Date('2026-08-20T12:00:00.000Z'),
  };
}

export function version(): WorkflowVersionRecord {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    workspaceId,
    workflowId,
    versionNumber: 1,
    graphJson: graph,
    checksum:
      'wf:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    publishedBy: actorId,
    publishedAt: new Date('2026-08-20T12:00:00.000Z'),
  };
}

export function authorization(
  overrides: Partial<{
    actorId: string;
    workspaceId: string;
    role: Role;
    membershipStatus: 'active' | 'suspended';
    workspaceStatus: 'active' | 'suspended' | 'pending_deletion';
  }> = {},
) {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
      ...overrides,
    }),
  };
}

export function persistence(
  overrides: Partial<WorkflowAuthoringPersistence> = {},
) {
  return {
    restoreWorkflowVersion: vi.fn().mockResolvedValue(draft({ revision: 2 })),
    duplicateWorkflow: vi.fn().mockResolvedValue({ workflowId }),
    transitionWorkflowLifecycle: vi
      .fn()
      .mockResolvedValue({ workflow: workflow(), replayed: false }),
    renameWorkflow: vi.fn().mockResolvedValue({
      workflow: { ...workflow(), name: 'Invoices', nameRevision: 2 },
      replayed: false,
    }),
    createWorkflow: vi.fn().mockResolvedValue({
      workflowId,
      workflow: workflow(),
      draft: draft(),
    }),
    listWorkflows: vi.fn().mockResolvedValue({ items: [workflow()] }),
    getWorkflow: vi.fn().mockResolvedValue(workflow()),
    getDraft: vi.fn().mockResolvedValue(draft()),
    validateDraft: vi.fn().mockResolvedValue({
      currentPublication: null,
      draft: draft(),
      validation: validateWorkflowGraph(graph),
    }),
    listVersions: vi.fn().mockResolvedValue({ items: [version()] }),
    saveDraft: vi.fn().mockResolvedValue(draft({ revision: 2 })),
    publishWorkflow: vi.fn().mockResolvedValue({
      version: version(),
      reused: false,
      replayed: false,
    }),
    ...overrides,
  } satisfies WorkflowAuthoringPersistence;
}

/** Roles and states that may neither publish nor edit an active workflow. */
export const MUTATION_DENIALS = [
  { role: 'viewer', workspaceStatus: 'active', membershipStatus: 'active' },
  { role: 'operator', workspaceStatus: 'active', membershipStatus: 'active' },
  { role: 'owner', workspaceStatus: 'suspended', membershipStatus: 'active' },
  {
    role: 'owner',
    workspaceStatus: 'pending_deletion',
    membershipStatus: 'active',
  },
  { role: 'owner', workspaceStatus: 'active', membershipStatus: 'suspended' },
] as const;

export function encodedCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export const templateOrigin = {
  templateId: 'controlled-http-notification',
  templateVersion: 1,
  baseManifestDigest: 'a'.repeat(64),
  creationCommandDigest: 'b'.repeat(64),
  derivation: 'direct',
} as const;
