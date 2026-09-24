import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export type StepChangeAspect =
  | 'label'
  | 'setup'
  | 'inputs'
  | 'connections'
  | 'enabled'
  | 'position'
  | 'type';

export type ChangedStep = Readonly<{
  before: WorkflowNode;
  after: WorkflowNode;
  aspects: readonly StepChangeAspect[];
}>;

export type WorkflowGraphDiff = Readonly<{
  added: readonly WorkflowNode[];
  removed: readonly WorkflowNode[];
  changed: readonly ChangedStep[];
  connectionsAdded: number;
  connectionsRemoved: number;
}>;

/**
 * Steps added, removed and changed between two graphs, matched by node ID.
 * `ignoreLayout` drops position-only changes, which never alter a run.
 */
export function diffWorkflowGraphs(
  before: WorkflowGraphContract,
  after: WorkflowGraphContract,
  options: Readonly<{ ignoreLayout?: boolean }> = {},
): WorkflowGraphDiff {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterIds = new Set(after.nodes.map((node) => node.id));
  const added: WorkflowNode[] = [];
  const changed: ChangedStep[] = [];
  for (const node of after.nodes) {
    const previous = beforeById.get(node.id);
    if (previous === undefined) {
      added.push(node);
      continue;
    }
    const aspects = changedAspects(previous, node).filter(
      (aspect) => options.ignoreLayout !== true || aspect !== 'position',
    );
    if (aspects.length > 0)
      changed.push({ before: previous, after: node, aspects });
  }
  const edgeKey = (edge: WorkflowGraphContract['edges'][number]) =>
    `${edge.source.nodeId}\u0000${edge.source.port}\u0000${edge.target.nodeId}\u0000${edge.target.port}`;
  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));
  return {
    added,
    removed: before.nodes.filter((node) => !afterIds.has(node.id)),
    changed,
    connectionsAdded: [...afterEdges].filter((key) => !beforeEdges.has(key))
      .length,
    connectionsRemoved: [...beforeEdges].filter((key) => !afterEdges.has(key))
      .length,
  };
}

export function isEmptyGraphDiff(diff: WorkflowGraphDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.connectionsAdded === 0 &&
    diff.connectionsRemoved === 0
  );
}

function changedAspects(
  before: WorkflowNode,
  after: WorkflowNode,
): StepChangeAspect[] {
  const aspects: StepChangeAspect[] = [];
  if (
    before.definition.key !== after.definition.key ||
    before.definition.version !== after.definition.version
  )
    aspects.push('type');
  if ((before.label ?? '') !== (after.label ?? '')) aspects.push('label');
  if (
    !sameJson(before.config, after.config) ||
    !sameJson(before.structured, after.structured)
  )
    aspects.push('setup');
  if (!sameJson(before.inputMappings, after.inputMappings))
    aspects.push('inputs');
  if (!sameJson(before.connectionRefs, after.connectionRefs))
    aspects.push('connections');
  if ((before.disabled ?? false) !== (after.disabled ?? false))
    aspects.push('enabled');
  if (
    before.position.x !== after.position.x ||
    before.position.y !== after.position.y
  )
    aspects.push('position');
  return aspects;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
