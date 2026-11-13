import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { WorkflowNodeUpdate } from '../graph/workflow-graph-commands';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

/** An update, or one computed from the step as it is in the draft now. */
export type NodeUpdateInput =
  WorkflowNodeUpdate | ((node: WorkflowNode) => WorkflowNodeUpdate);

/**
 * What every inspector control needs to live-apply its value: commit a
 * valid change as one coalesced edit, and report unfinished scratch.
 */
export type NodeFormApi = Readonly<{
  nodeId: string;
  editable: boolean;
  commit: (update: NodeUpdateInput, coalesceKey: string) => void;
  reportScratch: (field: string, hasScratch: boolean) => void;
}>;

export function fieldControlId(nodeId: string, fieldKey: string): string {
  return `config-${nodeId}-${fieldKey}`;
}

export const fieldDescriptionId = (id: string) => `${id}-description`;
export const fieldErrorId = (id: string) => `${id}-error`;

/**
 * What a field's control is described by: its help, always, and its error
 * while there is one, so a screen reader reads both with the label.
 */
export function describedBy(
  id: string,
  description: string | undefined,
  error?: string,
): string | undefined {
  const ids = [
    description === undefined ? undefined : fieldDescriptionId(id),
    error === undefined ? undefined : fieldErrorId(id),
  ].filter((value) => value !== undefined);
  return ids.length === 0 ? undefined : ids.join(' ');
}
