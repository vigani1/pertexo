import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
  type RecoveryNode,
} from '@pertexo/workflow-engine';
import type { WorkflowRecoveryMetadata } from '../../../src/runs/index.js';
import type { JsonValue } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';
import { recoveryPreparation } from '../../../src/execution/runs/prepare-recovery.js';
import {
  RUN_ID,
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from '../support/workflow.fixture.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const completed = new Date('2026-10-13T00:00:00.000Z');
const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
function fixture(callable = false) {
  const executable = buildWorkflowExecutable({
    graph: {
      ...graph(),
      ...(callable
        ? {
            callable: {
              input: { type: 'string' },
              resultType: { type: 'string' },
              result: { kind: 'run_input', path: '$' },
            },
          }
        : {}),
    },
    catalog,
  });
  const nodes: RecoveryNode[] = ['manual', 'terminate'].map((nodeId, i) => {
    const status = i === 0 ? 'succeeded' : 'failed';
    return {
      id: id(i + 1),
      nodeId,
      invocationKey: invocationKey({ workflowVersionId: VERSION_ID, nodeId }),
      status,
      sideEffectClass: 'safe',
      currentAttemptId: id(i + 11),
      currentAttemptNumber: 1,
      completedAt: completed.toISOString(),
      attempts: [
        {
          id: id(i + 11),
          number: 1,
          status,
          failureKind: i === 0 ? null : 'failed',
          errorKind: i === 0 ? null : 'configuration',
          possiblyDispatched: i === 0 ? null : false,
          dispatchMarked: false,
          retryDecision: i === 0 ? null : 'failed',
        },
      ],
    };
  });
  const metadata: WorkflowRecoveryMetadata = {
    run: {
      id: RUN_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      workflowVersionId: VERSION_ID,
      status: 'failed',
      triggerType: 'manual',
      createdAt: completed,
      updatedAt: completed,
      startedAt: completed,
      completedAt: completed,
      deadlineAt: null,
      cancelRequestedAt: null,
    },
    workflow: {
      id: VERSION_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      versionNumber: 1,
      checksum: executable.checksum,
      executableJson: executable.envelope,
    },
    checkpoint: {
      ...createCheckpoint({
        workflowVersionId: VERSION_ID,
        iterationBudget: 200,
      }),
      runStatus: 'failed',
      invocations: nodes.map((n) => ({
        nodeId: n.nodeId,
        invocationKey: n.invocationKey,
        status: n.status,
        attemptNumber: 1,
        ...(n.status === 'succeeded'
          ? { output: { kind: 'inline', attemptId: n.currentAttemptId } }
          : {}),
      })),
    },
    nodes,
    failedStep: { nodeId: 'terminate', label: 'Finish' },
  };
  return metadata;
}
function values(input: JsonValue) {
  return {
    input: { kind: 'inline' as const, value: input },
    outputs: new Map([
      [
        id(1),
        {
          node: { kind: 'inline' as const, value: 'owned' },
          attempt: { kind: 'inline' as const, value: 'owned' },
        },
      ],
    ]),
  };
}
describe('verified storage-to-recovery boundary', () => {
  it('keeps labels and risk in a preview while values stay in the private seed', () => {
    const prepared = recoveryPreparation({ catalog })(fixture());
    if (prepared.kind !== 'candidate') throw new Error('Expected candidate');
    const result = prepared.complete(values('original'));
    if (result.kind !== 'eligible') throw new Error('Expected eligible');
    expect(result.preview).toMatchObject({
      nodeId: 'terminate',
      nodeLabel: 'Finish',
      reusedCount: 1,
    });
    expect(JSON.stringify(result.preview)).not.toContain('owned');
    expect(
      result.seed({ runId: id(100), nodeRunIds: new Map([[id(1), id(101)]]) }),
    ).toMatchObject({
      kind: 'seeded',
      copies: [{ id: id(101), value: 'owned' }],
    });
  });
  it('revalidates the exact callable input contract before accepting copied data', () => {
    const prepared = recoveryPreparation({ catalog })(fixture(true));
    if (prepared.kind !== 'candidate') throw new Error('Expected candidate');
    expect(prepared.complete(values(42))).toEqual({
      kind: 'refused',
      reason: 'evidence_unavailable',
    });
    expect(prepared.complete(values('original')).kind).toBe('eligible');
    expect(
      prepared.complete({ ...values('original'), input: { kind: 'none' } }),
    ).toEqual({ kind: 'refused', reason: 'evidence_unavailable' });
  });
  it('refuses inconsistent publication identity, changed executable and incomplete checkpoint evidence', () => {
    const metadata = fixture();
    const prepare = recoveryPreparation({ catalog });
    expect(
      prepare({
        ...metadata,
        workflow: { ...metadata.workflow, workspaceId: id(999) },
      }),
    ).toEqual({ kind: 'refused', reason: 'version_unavailable' });
    expect(
      prepare({
        ...metadata,
        workflow: {
          ...metadata.workflow,
          checksum: `wf:sha256:${'a'.repeat(64)}`,
        },
      }),
    ).toEqual({ kind: 'refused', reason: 'version_unavailable' });
    expect(prepare({ ...metadata, checkpoint: {} })).toEqual({
      kind: 'refused',
      reason: 'evidence_unavailable',
    });
  });
});
