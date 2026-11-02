import { noteTextStart } from './note-text';
import type { WorkflowGraphContract } from '@pertexo/contracts';

export type NoteChange = Readonly<{
  kind: 'added' | 'removed' | 'changed';
  id: string;
  label: string;
  detail?: string;
}>;

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export type StepChangeAspect =
  | 'label'
  | 'setup'
  | 'inputs'
  | 'connections'
  | 'enabled'
  | 'position'
  | 'placement'
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
  notes: readonly NoteChange[];
  linksAdded: number;
  linksRemoved: number;
}>;

type GraphEdge = WorkflowGraphContract['edges'][number];
type GraphLevel = Readonly<{
  nodes: readonly WorkflowNode[];
  edges?: readonly GraphEdge[];
}>;

/** Every step in a graph, in order, with the For each it sits inside. */
export function graphSteps(
  graph: Pick<GraphLevel, 'nodes'>,
): readonly Readonly<{ node: WorkflowNode; inside: WorkflowNode | null }>[] {
  const steps: { node: WorkflowNode; inside: WorkflowNode | null }[] = [];
  const visit = (
    nodes: readonly WorkflowNode[],
    inside: WorkflowNode | null,
  ) => {
    for (const node of nodes) {
      steps.push({ node, inside });
      if (node.structured !== undefined)
        visit(node.structured.body.nodes, node);
    }
  };
  visit(graph.nodes, null);
  return steps;
}

function graphLinks(level: GraphLevel): readonly GraphEdge[] {
  return [
    ...(level.edges ?? []),
    ...level.nodes.flatMap((node) =>
      node.structured === undefined ? [] : graphLinks(node.structured.body),
    ),
  ];
}

/**
 * Steps added, removed and changed between two graphs, matched by node ID and
 * including steps inside a For each. `ignoreLayout` drops position-only changes,
 * which never alter a run.
 */
export function diffWorkflowGraphs(
  before: WorkflowGraphContract,
  after: WorkflowGraphContract,
  options: Readonly<{ ignoreLayout?: boolean }> = {},
): WorkflowGraphDiff {
  const beforeSteps = graphSteps(before);
  const afterSteps = graphSteps(after);
  const beforeById = new Map(beforeSteps.map((step) => [step.node.id, step]));
  const afterIds = new Set(afterSteps.map(({ node }) => node.id));
  const added: WorkflowNode[] = [];
  const changed: ChangedStep[] = [];
  for (const { node, inside } of afterSteps) {
    const previous = beforeById.get(node.id);
    if (previous === undefined) {
      added.push(node);
      continue;
    }
    const aspects: StepChangeAspect[] = [
      ...changedAspects(previous.node, node).filter(
        (aspect) => !(options.ignoreLayout ?? false) || aspect !== 'position',
      ),
      // Unlike moving on the canvas, this changes how often the step runs.
      ...(previous.inside?.id === inside?.id ? [] : (['placement'] as const)),
    ];
    if (aspects.length > 0)
      changed.push({ before: previous.node, after: node, aspects });
  }
  const edgeKey = (edge: GraphEdge) =>
    `${edge.source.nodeId}\u0000${edge.source.port}\u0000${edge.target.nodeId}\u0000${edge.target.port}`;
  const beforeEdges = new Set(graphLinks(before).map(edgeKey));
  const afterEdges = new Set(graphLinks(after).map(edgeKey));
  return {
    added,
    notes: diffNotes(before, after),
    removed: beforeSteps
      .map(({ node }) => node)
      .filter((node) => !afterIds.has(node.id)),
    changed,
    linksAdded: [...afterEdges].filter((key) => !beforeEdges.has(key)).length,
    linksRemoved: [...beforeEdges].filter((key) => !afterEdges.has(key)).length,
  };
}

/** A For each's own setup. The steps inside it are compared as steps. */
function ownSetup(node: WorkflowNode): unknown {
  if (node.structured === undefined) return undefined;
  const { nodes: _nodes, edges: _edges, ...body } = node.structured.body;
  return { ...node.structured, body };
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
    !sameJson(before.retry, after.retry) ||
    !sameJson(ownSetup(before), ownSetup(after))
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

const ASPECT_WORDS: Readonly<Record<StepChangeAspect, string>> = {
  label: 'renamed',
  setup: 'setup',
  inputs: 'inputs',
  connections: 'connection',
  enabled: 'turned on or off',
  position: 'moved',
  placement: 'moved in or out of a For each',
  type: 'step type',
};

/** What changed about a step, in a few words: "setup, inputs". */
export function describeStepChange(
  aspects: readonly StepChangeAspect[],
): string {
  return aspects.map((aspect) => ASPECT_WORDS[aspect]).join(', ');
}

function diffNotes(
  before: WorkflowGraphContract,
  after: WorkflowGraphContract,
): NoteChange[] {
  const previous = new Map((before.notes ?? []).map((note) => [note.id, note]));
  const current = new Map((after.notes ?? []).map((note) => [note.id, note]));
  const changes: NoteChange[] = [];
  const label = (text: string) => `Note: ${noteTextStart(text) || 'Untitled'}`;
  for (const note of current.values()) {
    const old = previous.get(note.id);
    if (old === undefined)
      changes.push({ kind: 'added', id: note.id, label: label(note.text) });
    else {
      const aspects = [
        old.text !== note.text ? 'text' : null,
        !sameJson(old.position, note.position) ? 'moved' : null,
        !sameJson(old.size, note.size) ? 'resized' : null,
        old.color !== note.color ? 'colour' : null,
      ].filter((value) => value !== null);
      if (aspects.length > 0)
        changes.push({
          kind: 'changed',
          id: note.id,
          label: label(note.text),
          detail: aspects.join(', '),
        });
    }
  }
  for (const note of previous.values())
    if (!current.has(note.id))
      changes.push({ kind: 'removed', id: note.id, label: label(note.text) });
  return changes;
}
