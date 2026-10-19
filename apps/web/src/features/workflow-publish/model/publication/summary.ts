import type {
  WorkflowGraphContract,
  WorkflowVersionResponse,
} from '@pertexo/contracts';
import { describeStep } from '@/features/catalog/presentation.public';
import {
  describeStepChange,
  diffWorkflowGraphs,
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
  linksAdded: number;
  linksRemoved: number;
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
      line('changed', change.after, describeStepChange(change.aspects)),
    ),
  ];
  return {
    nextVersionNumber: (latest?.versionNumber ?? 0) + 1,
    previousVersionNumber: latest?.versionNumber ?? null,
    lines,
    linksAdded: diff.linksAdded,
    linksRemoved: diff.linksRemoved,
    layoutOnly:
      lines.length === 0 &&
      diff.linksAdded === 0 &&
      diff.linksRemoved === 0 &&
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
