import { createHash } from 'node:crypto';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  authoring,
  actorId,
  workspaceId,
  draftNode,
  randomUUID,
  currentRepresentationTag,
} from '../../support/workflow-authoring.js';
export async function fixture(count = 1, sampleWorkspaceId = workspaceId) {
  const graph = parseWorkflowGraphDraft({
    nodes: Array.from({ length: count }, (_, index) =>
      draftNode(index === 0 ? 'sample' : `sample-${String(index)}`, {
        value: 'real',
      }),
    ),
    edges: [],
    settings: {},
  });
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId: sampleWorkspaceId,
    emptyGraph: graph,
    name: 'Pinned sample proof',
    idempotencyKey: randomUUID(),
  });
  return {
    scope: {
      actorId,
      workspaceId: sampleWorkspaceId,
      workflowId: created.workflowId,
      nodeId: 'sample',
    },
    graph,
    revision: created.draft.revision,
  };
}
export async function save(
  f: Awaited<ReturnType<typeof fixture>>,
  graph = f.graph,
) {
  const current = await authoring.getDraft(
    f.scope.workspaceId,
    f.scope.workflowId,
    f.scope.actorId,
  );
  if (current === null) throw new Error('Missing sample draft');
  return authoring.saveDraft({
    ...f.scope,
    graphJson: graph,
    expectedRevision: current.revision,
    representationTag: await currentRepresentationTag(
      authoring,
      f.scope.workspaceId,
      { scopedWorkflowId: f.scope.workflowId, scopedActorId: actorId },
    ),
  });
}
export function paste(
  f: Awaited<ReturnType<typeof fixture>>,
  value: unknown = { fixture: true },
) {
  return {
    ...f.scope,
    expectedDraftRevision: f.revision,
    expectedSampleId: null,
    idempotencyKey: randomUUID(),
    source: { kind: 'json' as const, value },
  };
}
export function testIntent(
  f: Awaited<ReturnType<typeof fixture>>,
  sampleId: string,
) {
  const hash = (text: string) =>
    createHash('sha256').update(text).digest('hex');
  return {
    workspaceId,
    workflowId: f.scope.workflowId,
    actorUserId: actorId,
    definitionKey: 'test.placeholder',
    definitionVersion: 1,
    draftFingerprint: hash('draft'),
    draftRevision: f.revision,
    expectedSampleId: sampleId,
    nodeId: 'sample',
    executorKey: 'test.placeholder',
    executorVersion: 1,
    executableNode: {
      id: 'sample',
      config: { value: 'real' },
      connectionRefs: {},
    },
    input: { kind: 'manual' as const, value: {} },
    sideEffectClass: 'unsafe' as const,
    mayContactProvider: true,
    mayCauseExternalSideEffect: true,
    dryRun: 'not_supported' as const,
    keyHash: hash(randomUUID()),
    requestHash: hash(randomUUID()),
    operation: 'preview.execute' as const,
    scope: `${actorId}:${f.scope.workflowId}`,
    expiresAt: new Date(Date.now() + 3600000),
    executionDeadlineAt: new Date(Date.now() + 60000),
  };
}
