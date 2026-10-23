import { randomUUID } from 'node:crypto';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  type AdvanceWorkflowInput,
  type WorkflowCallOutcome,
  type WorkflowCheckpoint,
  type WorkflowTransitionPlan,
} from '../../../src/index.js';
import { graph, nodeCatalog } from '../../support/executable-workflow.js';

export const target = {
  workflowId: randomUUID(),
  workflowVersionId: randomUUID(),
  executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
};
export const occurredAt = '2026-10-11T01:00:00.000Z';
export function callGraph(): WorkflowGraph {
  const original = graph();
  return {
    ...original,
    nodes: original.nodes.map((node) => {
      if (node.id === 'set') {
        return {
          ...node,
          id: 'call',
          definition: { key: 'core.call', version: 1 },
          config: { target },
          inputMappings: { input: { kind: 'run_input', path: '$' } },
        };
      }
      if (node.id === 'terminate') {
        return {
          ...node,
          inputMappings: {
            result: { kind: 'node_output', nodeId: 'call', path: '$' },
          },
        };
      }
      return node;
    }),
    edges: original.edges.map((edge) => ({
      ...edge,
      source: {
        ...edge.source,
        nodeId: edge.source.nodeId === 'set' ? 'call' : edge.source.nodeId,
      },
      target: {
        ...edge.target,
        nodeId: edge.target.nodeId === 'set' ? 'call' : edge.target.nodeId,
      },
    })),
  };
}
export function runtime(graph: WorkflowGraph = callGraph()) {
  const workflowVersionId = randomUUID();
  const executable = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(
      nodeCatalog({ call: true, forEach: true }),
    ),
  });
  const base = {
    workflowVersionId,
    executable,
    runId: randomUUID(),
    occurredAt,
    maximumAdmissions: 10,
    signal: new AbortController().signal,
  };
  const advance = (
    checkpoint: WorkflowCheckpoint,
    facts: Partial<
      Omit<AdvanceWorkflowInput, keyof typeof base | 'checkpoint'>
    > = {},
  ) => advanceWorkflow({ ...base, checkpoint, ...facts });
  return {
    advance,
    initial: () =>
      advance(createCheckpoint({ workflowVersionId, iterationBudget: 200 })),
  };
}
export function completion(
  plan: WorkflowTransitionPlan,
  value: unknown = {},
  index = 0,
) {
  const attempt = plan.attempts[index];
  if (attempt === undefined) throw new Error('fixture attempt missing');
  const attemptId = randomUUID();
  const sequence = plan.checkpoint.nextEventSequence;
  return {
    observations: [
      {
        kind: 'outcome',
        sequence,
        occurredAt,
        attemptId,
        attemptNumber: attempt.attemptNumber,
        invocationKey: attempt.invocationKey,
        status: 'succeeded',
        output: { kind: 'inline', attemptId },
      },
    ],
    completedOutputs: [
      { sequence, attemptId, invocationKey: attempt.invocationKey, value },
    ],
  };
}
export function childOutcome(
  plan: WorkflowTransitionPlan,
  status: WorkflowCallOutcome['status'] = 'succeeded',
  index = 0,
): WorkflowCallOutcome {
  const owner = plan.checkpoint.invocations.filter(
    ({ waitKind }) => waitKind === 'workflow_call',
  )[index];
  if (owner === undefined) throw new Error('fixture Call wait missing');
  return {
    callId: randomUUID(),
    nodeId: owner.nodeId,
    invocationKey: owner.invocationKey,
    status,
    ...(owner.branchPath === undefined ? {} : { branchPath: owner.branchPath }),
    ...(owner.iterationPath === undefined
      ? {}
      : { iterationPath: owner.iterationPath }),
  };
}
export async function declaredCall() {
  const run = runtime();
  const initial = await run.initial();
  const prepared = await run.advance(initial.checkpoint, completion(initial));
  const declared = await run.advance(
    prepared.checkpoint,
    completion(prepared, { privateInput: true }),
  );
  return { run, initial, prepared, declared };
}
