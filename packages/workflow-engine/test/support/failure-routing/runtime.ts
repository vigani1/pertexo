import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
  type WorkflowTransitionPlan,
} from '../../../src/index.js';
import { graph, nodeCatalog } from '../executable-workflow.js';
export const version = '00000000-0000-4000-8000-000000000001';
export const at = '2026-10-14T00:00:00.000Z';
export const id = '00000000-0000-4000-8000-000000000002';
export const key = (nodeId: string) =>
  invocationKey({ workflowVersionId: version, nodeId });
export function fixture() {
  const base = graph();
  const routed: WorkflowGraph = {
    ...base,
    nodes: [
      ...base.nodes,
      {
        ...base.nodes[1],
        id: 'handler',
        inputMappings: {
          reason: {
            kind: 'node_failure',
            nodeId: 'set',
            path: '$.safeErrorCode',
          },
        },
      },
      { ...base.nodes[2], id: 'handler-stop', inputMappings: {} },
    ],
    edges: [
      ...base.edges,
      {
        id: 'failure',
        source: { nodeId: 'set', port: '__failure' },
        target: { nodeId: 'handler', port: 'in' },
      },
      {
        id: 'handler-end',
        source: { nodeId: 'handler', port: 'out' },
        target: { nodeId: 'handler-stop', port: 'in' },
      },
    ],
  };
  const executable = buildWorkflowExecutable({
    graph: routed,
    catalog: composeExecutableCatalog(nodeCatalog()),
  });
  let checkpoint = createCheckpoint({
    workflowVersionId: version,
    iterationBudget: 100,
  });
  async function step(
    observations: unknown = [],
    occurredAt = at,
  ): Promise<WorkflowTransitionPlan> {
    const plan = await advanceWorkflow({
      runId: id,
      executable,
      workflowVersionId: version,
      checkpoint,
      observations,
      occurredAt,
      maximumAdmissions: 5,
      signal: new AbortController().signal,
    });
    checkpoint = plan.checkpoint;
    return plan;
  }
  async function success(nodeId: string) {
    return step([
      {
        sequence: checkpoint.nextEventSequence,
        occurredAt: at,
        kind: 'outcome',
        invocationKey: key(nodeId),
        status: 'succeeded',
        output: { kind: 'inline', attemptId: id },
        attemptId: id,
        attemptNumber: 1,
      },
    ]);
  }
  async function fail({
    nodeId = 'set',
    failureKind = 'failed',
    errorKind = 'authentication',
    attemptNumber = 1,
    safeErrorCode = `execution.${errorKind}`,
  }: Readonly<{
    nodeId?: string | undefined;
    failureKind?: string | undefined;
    errorKind?: string | undefined;
    attemptNumber?: number | undefined;
    safeErrorCode?: string | undefined;
  }> = {}) {
    return step([
      {
        occurredAt: at,
        kind: 'attempt_failure',
        invocationKey: key(nodeId),
        attemptId: id,
        attemptNumber,
        failureKind,
        errorKind,
        possiblyDispatched: false,
        safeErrorCode,
      },
    ]);
  }
  return { executable, step, success, fail, checkpoint: () => checkpoint };
}
