import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
} from '../../src/index.js';
import type {
  BranchScopePart,
  CompiledWorkflowExecutable,
} from '../../src/index.js';
import type {
  RecoveryNode,
  RecoverySource,
} from '../../src/recovery/contract.js';
import { graph, nodeCatalog } from '../support/executable-workflow.js';

export const completedAt = '2026-10-13T00:00:00.000Z';
export const id = (ordinal: number) =>
  `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`;
export const versionId = id(200);

export function record(
  executable: CompiledWorkflowExecutable,
  {
    nodeId,
    ordinal,
    status,
    branchPath = [],
  }: Readonly<{
    nodeId: string;
    ordinal: number;
    status: 'succeeded' | 'failed';
    branchPath?: readonly BranchScopePart[] | undefined;
  }>,
): RecoveryNode {
  const node = executable.envelope.graph.nodes.find(
    (candidate) => candidate.id === nodeId,
  );
  if (node === undefined) throw new Error('Missing fixture node');
  return {
    id: id(ordinal),
    nodeId,
    invocationKey: invocationKey({
      workflowVersionId: versionId,
      nodeId,
      branchPath: branchPath.map((part) => `${part.nodeId}:${part.outputPort}`),
    }),
    status,
    sideEffectClass: node.sideEffectClass,
    currentAttemptId: id(100 + ordinal),
    currentAttemptNumber: 1,
    completedAt,
    ...(branchPath.length === 0 ? {} : { branchPath }),
    attempts: [
      {
        id: id(100 + ordinal),
        number: 1,
        status,
        failureKind: status === 'failed' ? 'failed' : null,
        errorKind: status === 'failed' ? 'configuration' : null,
        possiblyDispatched: status === 'failed' ? false : null,
        dispatchMarked: false,
        retryDecision: status === 'failed' ? 'failed' : null,
      },
    ],
  };
}

export function source(nodes: readonly RecoveryNode[]): RecoverySource {
  return {
    id: id(300),
    workflowVersionId: versionId,
    status: 'failed',
    completedAt,
    nodes,
    checkpoint: {
      ...createCheckpoint({
        workflowVersionId: versionId,
        iterationBudget: 1_000,
      }),
      runStatus: 'failed',
      revision: 10,
      nextEventSequence: 20,
      invocations: nodes.map((node) => ({
        invocationKey: node.invocationKey,
        nodeId: node.nodeId,
        status: node.status,
        attemptNumber: node.currentAttemptNumber ?? 0,
        ...(node.branchPath === undefined
          ? {}
          : { branchPath: node.branchPath }),
        ...(node.status !== 'succeeded'
          ? {}
          : {
              output:
                node.reused === undefined
                  ? {
                      kind: 'inline' as const,
                      attemptId: node.currentAttemptId ?? '',
                    }
                  : { kind: 'reused' as const, nodeRunId: node.id },
            }),
      })),
    },
  };
}

export function linear(unsafe = false) {
  const executable = buildWorkflowExecutable({
    graph: graph(),
    catalog: composeExecutableCatalog(
      nodeCatalog({ setRetryClass: unsafe ? 'unsafe' : 'safe' }),
    ),
  });
  return {
    executable,
    source: source([
      record(executable, { nodeId: 'manual', ordinal: 1, status: 'succeeded' }),
      record(executable, { nodeId: 'set', ordinal: 2, status: 'failed' }),
    ]),
  };
}

export function conditional(port: 'true' | 'false') {
  const base = graph();
  const branchGraph: WorkflowGraph = {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'condition',
        definition: { key: 'core.condition', version: 1 },
        inputMappings: {
          condition: { kind: 'literal', value: port === 'true' },
        },
      },
      { ...base.nodes[2], inputMappings: {} },
    ],
    edges: [
      {
        id: 'entry-condition',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'condition', port: 'in' },
      },
      {
        id: 'chosen-stop',
        source: { nodeId: 'condition', port },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  };
  const executable = buildWorkflowExecutable({
    graph: branchGraph,
    catalog: composeExecutableCatalog(nodeCatalog({ condition: true })),
  });
  const condition = record(executable, {
    nodeId: 'condition',
    ordinal: 2,
    status: 'succeeded',
  });
  const retained = source([
    record(executable, { nodeId: 'manual', ordinal: 1, status: 'succeeded' }),
    condition,
    record(executable, {
      nodeId: 'terminate',
      ordinal: 3,
      status: 'failed',
      branchPath: [{ nodeId: 'condition', outputPort: port }],
    }),
  ]);
  return {
    executable,
    source: {
      ...retained,
      checkpoint: {
        ...retained.checkpoint,
        branchSelections: [
          {
            invocationKey: condition.invocationKey,
            nodeId: 'condition',
            selectedOutputPort: port,
          },
        ],
      },
    },
  };
}
