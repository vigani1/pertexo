import {
  createCheckpoint,
  parseCheckpoint,
  type WorkflowCheckpointV1,
} from '../../src/index.js';
import {
  advanceWorkflow as advanceWorkflowForTesting,
  parseSchedulerGraph,
  type AdvanceWorkflowInput,
  type SchedulerGraph,
} from '../../src/testing.js';

export const occurredAt = '2026-08-20T10:00:00.000Z';
export const chainGraph = {
  schemaVersion: 1,
  settings: {},
  nodes: ['a', 'b'].map((id) => ({
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  })),
  edges: [
    {
      id: 'a-b',
      source: { nodeId: 'a', port: 'output' },
      target: { nodeId: 'b', port: 'input' },
    },
  ],
} as const;

export function checkpoint(): WorkflowCheckpointV1 {
  return createCheckpoint({
    engineVersion: 'engine-v1',
    workflowVersionId: 'version-1',
    iterationBudget: 1_000,
  });
}

function explicitSchedulerState(input: AdvanceWorkflowInput): SchedulerGraph {
  if (input.schedulerState !== undefined) return input.schedulerState;
  if (input.graph !== undefined) return parseSchedulerGraph(input.graph);
  const parsed = parseCheckpoint(input.checkpoint);
  const nodeIds = new Set(parsed.invocations.map(({ nodeId }) => nodeId));
  for (const observation of input.observations ?? []) {
    if (observation.kind === 'ready') nodeIds.add(observation.nodeId);
    else if (observation.kind === 'join_declared')
      nodeIds.add(observation.joinId);
    else if (
      observation.kind === 'loop_started' ||
      observation.kind === 'loop_iteration_completed'
    )
      nodeIds.add(observation.loopId);
  }
  return {
    deriveReadiness: false,
    nodes: [...nodeIds].map((id) => ({ id, sideEffectClass: 'safe' })),
    edges: [],
  };
}

export function advanceWorkflow(input: AdvanceWorkflowInput) {
  const schedulerState = explicitSchedulerState(input);
  const { graph: _, ...withoutGraph } = input;
  void _;
  return advanceWorkflowForTesting({ ...withoutGraph, schedulerState });
}
