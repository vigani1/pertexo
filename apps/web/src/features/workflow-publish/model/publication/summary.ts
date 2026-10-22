import type {
  WorkflowGraphContract,
  WorkflowVersionResponse,
} from '@pertexo/contracts';
import { describeStep } from '@/features/catalog/presentation.public';
import {
  describeStepChange,
  diffWorkflowGraphs,
} from '@/features/workflow-drafts/public';
import { triggerKindOf } from '@/features/workflows/shape.public';

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
    ...diff.notes.map((note) => ({
      kind: note.kind,
      nodeId: `note:${note.id}`,
      name: note.label,
      ...(note.detail === undefined ? {} : { detail: note.detail }),
    })),
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
    // Triggers that start runs on their own; a manual start is a run
    // someone starts, which the dialog already describes.
    triggerNames: draft.nodes
      .filter((node) => {
        const kind = triggerKindOf(node.definition);
        return kind !== undefined && kind !== 'core.manual';
      })
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
