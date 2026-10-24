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
      (aspect) => !(options.ignoreLayout ?? false) || aspect !== 'position',
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
    notes: diffNotes(before, after),
    removed: before.nodes.filter((node) => !afterIds.has(node.id)),
    changed,
    linksAdded: [...afterEdges].filter((key) => !beforeEdges.has(key)).length,
    linksRemoved: [...beforeEdges].filter((key) => !afterEdges.has(key)).length,
  };
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

const ASPECT_WORDS: Readonly<Record<StepChangeAspect, string>> = {
  label: 'renamed',
  setup: 'setup',
  inputs: 'inputs',
  connections: 'connection',
  enabled: 'turned on or off',
  position: 'moved',
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
