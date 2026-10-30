import {
  WORKFLOW_GRAPH_LIMITS,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { buildWorkflowExecutable } from '../compilation/compile.js';
import {
  executionNodes,
  type WorkflowExecutableGraph,
} from '../compilation/foundation.js';
import { createCheckpoint } from '../checkpoint/create-and-parse.js';
import { testStepDisposition, type WorkflowTestPins } from './policy.js';
import { validWorkflowTestPin } from './pins.js';

/** Pure test admission facts; storage freezes these under its own authority locks. */
export function buildWorkflowTestExecutable(
  input: Readonly<{
    graph: WorkflowGraph;
    catalog: unknown;
    pins: WorkflowTestPins;
  }>,
) {
  const executable = buildWorkflowExecutable(input);
  const test = { pinnedNodeIds: Object.keys(input.pins) };
  const nodes = executionNodes(executable);
  const candidates = (function unpinnedSteps(
    graph: WorkflowExecutableGraph,
  ): WorkflowExecutableGraph['nodes'] {
    return graph.nodes.flatMap((node) =>
      node.disabled
        ? []
        : [
            node,
            ...(node.structured === undefined ||
            Object.hasOwn(input.pins, node.id)
              ? []
              : unpinnedSteps(node.structured.body)),
          ],
    );
  })(executable.envelope.graph).filter(
    (node) => testStepDisposition(node, test).kind === 'execute',
  );
  return {
    checksum: executable.checksum,
    executableJson: executable.envelope,
    dispositions: Object.fromEntries(
      nodes.map((node) => [node.id, testStepDisposition(node, test).kind]),
    ),
    invalidPinIds: nodes
      .filter((node) => {
        const pin = input.pins[node.id];
        return pin !== undefined && !validWorkflowTestPin(node, pin);
      })
      .map((node) => node.id),
    effectfulNodeIds: candidates
      .filter((node) => node.sideEffectClass !== 'safe')
      .map((node) => node.id),
    usesConnections: candidates.some(
      (node) => Object.keys(node.connectionRefs).length > 0,
    ),
    initialCheckpoint: (workflowTestId: string) =>
      createCheckpoint({
        workflowVersionId: workflowTestId,
        nextEventSequence: 2,
        iterationBudget: WORKFLOW_GRAPH_LIMITS.maxTotalLoopIterations,
      }),
  };
}
export type WorkflowTestCompilation = ReturnType<
  typeof buildWorkflowTestExecutable
>;
