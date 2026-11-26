import { noteTextStart } from './note-text';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { canonicalJson } from '@pertexo/workflow-model';

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
  | 'configVersion'
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
  settings: readonly DraftFieldChange<WorkflowNode['config'][string]>[];
  mappings: readonly DraftFieldChange<WorkflowNode['inputMappings'][string]>[];
}>;

export type DraftFieldChange<Value> = Readonly<{
  name: string;
  before: Value | undefined;
  after: Value | undefined;
}>;

export type WorkflowGraphDiff = Readonly<{
  added: readonly WorkflowNode[];
  removed: readonly WorkflowNode[];
  changed: readonly ChangedStep[];
  notes: readonly NoteChange[];
  addedLinks: readonly LinkEndpoints[];
  removedLinks: readonly LinkEndpoints[];
  linksAdded: number;
  linksRemoved: number;
}>;

type GraphEdge = WorkflowGraphContract['edges'][number];
type LinkEndpoints = Pick<GraphEdge, 'source' | 'target'>;
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
    const settings = fieldChanges(previous.node.config, node.config);
    const mappings = fieldChanges(
      previous.node.inputMappings,
      node.inputMappings,
    );
    const aspects: StepChangeAspect[] = [
      ...changedAspects(previous.node, node, { settings, mappings }).filter(
        (aspect) => !(options.ignoreLayout ?? false) || aspect !== 'position',
      ),
      // Unlike moving on the canvas, this changes how often the step runs.
      ...(previous.inside?.id === inside?.id ? [] : (['placement'] as const)),
    ];
    if (aspects.length > 0)
      changed.push({
        before: previous.node,
        after: node,
        aspects,
        settings,
        mappings,
      });
  }
  const edgeKey = (edge: LinkEndpoints) =>
    `${edge.source.nodeId}\u0000${edge.source.port}\u0000${edge.target.nodeId}\u0000${edge.target.port}`;
  const byEndpoints = (graph: WorkflowGraphContract) =>
    new Map(
      graphLinks(graph).map(({ source, target }) => [
        edgeKey({ source, target }),
        { source, target },
      ]),
    );
  const beforeEdges = byEndpoints(before);
  const afterEdges = byEndpoints(after);
  const addedLinks = [...afterEdges].flatMap(([key, link]) =>
    beforeEdges.has(key) ? [] : [link],
  );
  const removedLinks = [...beforeEdges].flatMap(([key, link]) =>
    afterEdges.has(key) ? [] : [link],
  );
  return {
    added,
    notes: diffNotes(before, after),
    removed: beforeSteps
      .map(({ node }) => node)
      .filter((node) => !afterIds.has(node.id)),
    changed,
    addedLinks,
    removedLinks,
    linksAdded: addedLinks.length,
    linksRemoved: removedLinks.length,
  };
}

function fieldChanges<Value>(
  before: Readonly<Record<string, Value>>,
  after: Readonly<Record<string, Value>>,
): readonly DraftFieldChange<Value>[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(
    (name) => {
      const previous = Object.hasOwn(before, name) ? before[name] : undefined;
      const current = Object.hasOwn(after, name) ? after[name] : undefined;
      if (
        previous === current ||
        (previous !== undefined &&
          current !== undefined &&
          canonicalJson(previous) === canonicalJson(current))
      )
        return [];
      return [{ name, before: previous, after: current }];
    },
  );
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
  { settings, mappings }: Pick<ChangedStep, 'settings' | 'mappings'>,
): StepChangeAspect[] {
  const aspects: StepChangeAspect[] = [];
  if (
    before.definition.key !== after.definition.key ||
    before.definition.version !== after.definition.version
  )
    aspects.push('type');
  if (before.configVersion !== after.configVersion)
    aspects.push('configVersion');
  if ((before.label ?? '') !== (after.label ?? '')) aspects.push('label');
  if (
    settings.length > 0 ||
    !sameJson(before.retry, after.retry) ||
    !sameJson(ownSetup(before), ownSetup(after))
  )
    aspects.push('setup');
  if (mappings.length > 0) aspects.push('inputs');
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
  configVersion: 'configuration version',
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
