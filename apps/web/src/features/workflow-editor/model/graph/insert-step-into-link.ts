import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { inspectWorkflowFailureRoutes } from '@pertexo/workflow-model';
import { connectionPorts } from '../step-card';
import { shownLevel } from './for-each-body-layout';
import { changeLevel } from './levels';
import { findStep, indexGraph, loopOf } from './scopes';
import {
  addBodyStep,
  addStepAfter,
  freePosition,
} from './workflow-graph-commands';

/** Adds one step in the link's level and replaces the link in a single draft edit. */
export function insertStepIntoLink({
  graph,
  edgeId,
  definition,
  nodeId,
  nextEdgeId,
}: Readonly<{
  graph: WorkflowGraphContract;
  edgeId: string;
  definition: NodeDefinitionCatalogItem;
  nodeId: string;
  nextEdgeId: string;
}>): WorkflowGraphContract | null {
  const link = indexGraph(graph).edges.get(edgeId);
  if (link === undefined) return null;
  const { item: edge, scope } = link;
  const level = shownLevel(graph, scope);
  const source = level?.nodes.find(({ id }) => id === edge.source.nodeId);
  const target = level?.nodes.find(({ id }) => id === edge.target.nodeId);
  if (level === undefined || source === undefined || target === undefined)
    return null;
  const position = freePosition(level, {
    x: (source.position.x + target.position.x) / 2,
    y: (source.position.y + target.position.y) / 2,
  });
  const placement = {
    graph,
    definition,
    position,
    from: edge.source,
    ids: { nodeId, edgeId: nextEdgeId },
  };
  const loopId = loopOf(scope);
  const added =
    loopId === undefined
      ? addStepAfter(placement)
      : addBodyStep({ ...placement, loopId });
  if (added === null) return null;
  const step = findStep(added, nodeId);
  const updatedLevel = shownLevel(added, scope);
  if (step === undefined || updatedLevel === undefined) return null;
  const outputs = connectionPorts(step, definition, updatedLevel, 'outputs');
  const port = outputs.includes(edge.target.port)
    ? edge.target.port
    : outputs[0];
  if (port === undefined) return null;
  const next = changeLevel(added, scope, (current) => ({
    ...current,
    edges: current.edges.map((link) =>
      link.id === edgeId ? { ...edge, source: { nodeId, port } } : link,
    ),
  }));
  return inspectWorkflowFailureRoutes(next).kind === 'invalid' ? null : next;
}
