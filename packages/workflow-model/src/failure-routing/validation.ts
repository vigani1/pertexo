import { isHumanTaskDefinition } from '../pending-tasks/approval.js';
import type { WorkflowEdge } from '../graph/contract.js';
import {
  inspectWorkflowDecisionTree,
  type DecisionTreeNode,
  type WorkflowDecisionTree,
} from './decision-tree.js';
import {
  isWorkflowFailureSource,
  WORKFLOW_FAILURE_PATHS,
  WORKFLOW_FAILURE_PORT,
  type WorkflowFailureRoute,
} from './contract.js';

type Mapping = Readonly<{ kind: string; nodeId?: string; path?: string }>;
export type FailureRoutingGraph = Readonly<{
  nodes: readonly (DecisionTreeNode &
    Readonly<{
      inputMappings: Readonly<Record<string, Mapping>>;
      structured?: Readonly<{ body: FailureRoutingGraph }> | undefined;
    }>)[];
  edges: readonly WorkflowEdge[];
  callable?: Readonly<{ result: Mapping }> | undefined;
}>;
export type WorkflowFailureRoutes = Readonly<{
  main: WorkflowDecisionTree;
  routes: ReadonlyMap<string, WorkflowFailureRoute>;
  handlerOwners: ReadonlyMap<string, string>;
}>;
export type FailureRoutingInspection =
  | Readonly<{ kind: 'ordinary' }>
  | Readonly<{ kind: 'invalid'; message: string }>
  | Readonly<{ kind: 'routed'; value: WorkflowFailureRoutes }>;
const invalid = (message: string): FailureRoutingInspection => ({
  kind: 'invalid',
  message,
});

/** One ownership/shape rule shared by authoring, compilation and execution. */
export function inspectWorkflowFailureRoutes(
  graph: FailureRoutingGraph,
): FailureRoutingInspection {
  for (const node of graph.nodes)
    if (node.structured !== undefined) {
      const body = inspectWorkflowFailureRoutes(node.structured.body);
      if (body.kind !== 'ordinary')
        return invalid(
          'Failure links and failure data cannot occur inside loop bodies.',
        );
    }
  if (graph.callable?.result.kind === 'node_failure')
    return invalid(
      'Failure data belongs only to its handler entry, not a callable result.',
    );
  const failures = graph.edges.filter(
    ({ source }) => source.port === WORKFLOW_FAILURE_PORT,
  );
  if (failures.length === 0) {
    if (
      graph.nodes.some((node) =>
        Object.values(node.inputMappings).some(
          ({ kind }) => kind === 'node_failure',
        ),
      )
    )
      return invalid('Failure data requires its source’s failure link.');
    return { kind: 'ordinary' };
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, WorkflowEdge[]>();
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of graph.edges) {
    const into = incoming.get(edge.target.nodeId) ?? [];
    into.push(edge);
    incoming.set(edge.target.nodeId, into);
    const from = outgoing.get(edge.source.nodeId) ?? [];
    from.push(edge);
    outgoing.set(edge.source.nodeId, from);
  }
  const owners = new Map<string, string>();
  const routes = new Map<string, WorkflowFailureRoute>();
  for (const failure of failures) {
    const source = nodes.get(failure.source.nodeId);
    if (
      source === undefined ||
      !isWorkflowFailureSource(source.definition) ||
      source.structured !== undefined
    )
      return invalid('Only ordinary actions can own a failure link.');
    if (routes.has(source.id))
      return invalid('A step can have only one failure link.');
    const handler: string[] = [];
    let next: string | undefined = failure.target.nodeId;
    while (next !== undefined) {
      const node = nodes.get(next);
      if (node === undefined || node.id === source.id || owners.has(node.id))
        return invalid(
          'Failure handlers cannot share steps, cycle or return to their source.',
        );
      if (
        (!isWorkflowFailureSource(node.definition) &&
          !(
            node.definition.key === 'core.terminate' &&
            node.definition.version === 1
          )) ||
        node.structured !== undefined ||
        isHumanTaskDefinition(node.definition)
      )
        return invalid(
          'Failure handlers contain sequential actions and may end in Stop run.',
        );
      if (node.disabled === true)
        return invalid('Failure handler steps cannot be disabled.');
      if ((incoming.get(node.id)?.length ?? 0) !== 1)
        return invalid(
          'A handler step must have one incoming link, with no normal-path convergence.',
        );
      const after = outgoing.get(node.id) ?? [];
      if (
        after.length > 1 ||
        after.some(({ source }) => source.port === WORKFLOW_FAILURE_PORT)
      )
        return invalid(
          'Failure handlers cannot branch or own another handler.',
        );
      if (node.definition.key === 'core.terminate' && after.length > 0)
        return invalid('Stop run must be a leaf.');
      owners.set(node.id, source.id);
      handler.push(node.id);
      next = after[0]?.target.nodeId;
    }
    const sink = handler.at(-1);
    if (sink === undefined) return invalid('A failure link needs a handler.');
    routes.set(source.id, {
      sourceNodeId: source.id,
      entryNodeId: failure.target.nodeId,
      sinkNodeId: sink,
      handlerNodeIds: handler,
    });
  }
  if ([...routes.keys()].some((sourceId) => owners.has(sourceId)))
    return invalid('A failure handler cannot own another failure link.');
  const main = inspectWorkflowDecisionTree({
    nodes: graph.nodes.filter(({ id }) => !owners.has(id)),
    edges: graph.edges.filter(
      ({ source, target }) =>
        source.port !== WORKFLOW_FAILURE_PORT &&
        !owners.has(source.nodeId) &&
        !owners.has(target.nodeId),
    ),
  });
  if (main === undefined)
    return invalid(
      'Failure links require a root decision tree with Condition, Approval and leaf Stop run; joins, fan-out, loops, Wait and Calls are unsupported.',
    );
  for (const node of graph.nodes)
    for (const mapping of Object.values(node.inputMappings)) {
      const sourceId = owners.get(node.id);
      const route = sourceId === undefined ? undefined : routes.get(sourceId);
      if (
        mapping.kind === 'node_failure' &&
        (route?.entryNodeId !== node.id ||
          mapping.nodeId !== sourceId ||
          !WORKFLOW_FAILURE_PATHS.includes(mapping.path ?? ''))
      )
        return invalid(
          'Only the handler entry can read its source’s allowlisted failure fields.',
        );
      if (
        mapping.kind === 'node_output' &&
        route?.entryNodeId === node.id &&
        mapping.nodeId === sourceId
      )
        return invalid(
          'A failed source has failure fields, not a successful output.',
        );
    }
  return { kind: 'routed', value: { main, routes, handlerOwners: owners } };
}
