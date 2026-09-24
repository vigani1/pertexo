import type {
  WorkflowGraphContract,
  WorkflowVersionResponse,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { describeStep } from '@/features/catalog/presentation.public';
import {
  diffWorkflowGraphs,
  type StepChangeAspect,
} from '@/features/workflow-drafts/public';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

export type PublishSummaryLine = Readonly<{
  kind: 'added' | 'removed' | 'changed';
  nodeId: string;
  name: string;
  detail?: string;
}>;

export type PublishSummary = Readonly<{
  /** The version this publish will most likely create. */
  nextVersionNumber: number;
  /** Null when nothing has been published yet. */
  previousVersionNumber: number | null;
  lines: readonly PublishSummaryLine[];
  connectionsAdded: number;
  connectionsRemoved: number;
  layoutOnly: boolean;
  triggerNames: readonly string[];
}>;

const TRIGGER_KEYS = new Set(['core.webhook', 'core.schedule']);

/**
 * What publishing changes against the latest published version, in step
 * names. Position-only moves never change a run, so they are left out.
 */
export function summarizePublish(
  draft: WorkflowGraphContract,
  latest: WorkflowVersionResponse | null,
): PublishSummary {
  const previous = latest?.graph ?? {
    schemaVersion: 1,
    nodes: [],
    edges: [],
    settings: {},
  };
  const diff = diffWorkflowGraphs(previous, draft, { ignoreLayout: true });
  const withLayout = diffWorkflowGraphs(previous, draft);
  const lines: PublishSummaryLine[] = [
    ...diff.added.map((node) => line('added', node)),
    ...diff.removed.map((node) => line('removed', node)),
    ...diff.changed.map((change) =>
      line('changed', change.after, describeAspects(change.aspects)),
    ),
  ];
  return {
    nextVersionNumber: (latest?.versionNumber ?? 0) + 1,
    previousVersionNumber: latest?.versionNumber ?? null,
    lines,
    connectionsAdded: diff.connectionsAdded,
    connectionsRemoved: diff.connectionsRemoved,
    layoutOnly:
      lines.length === 0 &&
      diff.connectionsAdded === 0 &&
      diff.connectionsRemoved === 0 &&
      withLayout.changed.length > 0,
    triggerNames: draft.nodes
      .filter((node) => TRIGGER_KEYS.has(node.definition.key))
      .map(nodeName),
  };
}

function line(
  kind: PublishSummaryLine['kind'],
  node: WorkflowNode,
  detail?: string,
): PublishSummaryLine {
  return {
    kind,
    nodeId: node.id,
    name: nodeName(node),
    ...(detail === undefined ? {} : { detail }),
  };
}

function nodeName(node: WorkflowNode): string {
  return node.label ?? describeStep(node.definition.key).name;
}

const aspectWords: Readonly<Record<StepChangeAspect, string>> = {
  label: 'renamed',
  setup: 'setup',
  inputs: 'inputs',
  connections: 'connection',
  enabled: 'turned on or off',
  position: 'moved',
  type: 'step type',
};

function describeAspects(aspects: readonly StepChangeAspect[]): string {
  return aspects.map((aspect) => aspectWords[aspect]).join(', ');
}
