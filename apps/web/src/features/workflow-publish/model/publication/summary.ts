import type {
  WorkflowGraphContract,
  WorkflowVersionResponse,
} from '@pertexo/contracts';
import { describeStep } from '@/features/catalog/presentation.public';
import { diffWorkflowGraphs } from '@/features/workflows/comparison.public';
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
  /** Webhook steps this publish removes; their addresses stop answering. */
  retiredWebhookNames: readonly string[];
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
  const diff = diffWorkflowGraphs(previous, draft);
  const lines: PublishSummaryLine[] = diff.lines.map((change) => ({
    kind: change.kind,
    nodeId: `${change.target}:${change.id}`,
    name: change.label,
    ...(change.detail === undefined ? {} : { detail: change.detail }),
  }));
  return {
    nextVersionNumber: (latest?.versionNumber ?? 0) + 1,
    previousVersionNumber: latest?.versionNumber ?? null,
    lines,
    linksAdded: diff.linksAdded,
    linksRemoved: diff.linksRemoved,
    layoutOnly: diff.layoutOnly,
    // Triggers that start runs on their own; a manual start is a run
    // someone starts, which the dialog already describes.
    triggerNames: draft.nodes
      .filter((node) => {
        const kind = triggerKindOf(node.definition);
        return kind !== undefined && kind !== 'core.manual';
      })
      .map(nodeName),
    retiredWebhookNames: previous.nodes
      .filter(
        (node) =>
          triggerKindOf(node.definition) === 'core.webhook' &&
          !draft.nodes.some(({ id }) => id === node.id),
      )
      .map(nodeName),
  };
}

function nodeName(node: WorkflowNode): string {
  return node.label ?? describeStep(node.definition.key).name;
}
