import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { WorkflowNodeUpdate } from './graph-commands';

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
