import type { SchedulerState } from '../transition/scheduling/readiness.js';
import type { JsonValue } from '@pertexo/workflow-model';
import {
  isHumanTaskDefinition,
  isCallbackWaitNode,
  isWorkflowCallDefinition,
} from '@pertexo/workflow-model';
import type { WorkflowExecutableNode } from '../compilation/foundation.js';

export type WorkflowTestPins = Readonly<
  Record<string, Readonly<{ sampleId: string; output: JsonValue }>>
>;
/** The coordinator needs pin identities, never their payloads. */
export type WorkflowTestPolicy = Readonly<{ pinnedNodeIds: readonly string[] }>;
export function testStepDisposition(
  node: Pick<WorkflowExecutableNode, 'id' | 'definition'> &
    Partial<Pick<WorkflowExecutableNode, 'config'>>,
  test: WorkflowTestPolicy,
) {
  if (test.pinnedNodeIds.includes(node.id)) return { kind: 'pinned' as const };
  if (
    isHumanTaskDefinition(node.definition) ||
    isWorkflowCallDefinition(node.definition)
  )
    return { kind: 'pin_required' as const };
  if (
    node.definition.key === 'core.wait' &&
    node.definition.version === 1 &&
    !isCallbackWaitNode(node)
  )
    return { kind: 'wait_skipped' as const };
  if (
    node.definition.key === 'core.respond_webhook' &&
    node.definition.version === 1
  )
    return { kind: 'response_skipped' as const };
  return { kind: 'execute' as const };
}
export function applyWorkflowTestPolicy(
  state: SchedulerState,
  nodes: readonly WorkflowExecutableNode[],
  test: WorkflowTestPolicy | undefined,
): SchedulerState {
  if (test === undefined) return state;
  const substituted = new Set(
    nodes
      .filter((node) => testStepDisposition(node, test).kind !== 'execute')
      .map((node) => node.id),
  );
  const project = (nodes: SchedulerState['nodes']) =>
    nodes.map((node) =>
      substituted.has(node.id)
        ? { ...node, sideEffectClass: 'safe' as const }
        : node,
    );
  return {
    ...state,
    nodes: project(state.nodes),
    ...(state.structuredBodies === undefined
      ? {}
      : {
          structuredBodies: state.structuredBodies.map((body) => ({
            ...body,
            nodes: project(body.nodes),
          })),
        }),
  };
}
