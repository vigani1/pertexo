import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { DescribeStep } from '@/features/catalog/public';
import type { DataTableFindConfig } from '@pertexo/node-sdk';
import {
  agentToolAllowedWithoutApproval,
  workflowDataTableBinding,
} from '@pertexo/workflow-model';
import {
  branchPorts,
  type BranchPorts,
} from '../step-inspection/branch-output';

export type StepLabel = Readonly<{
  label: string;
  kindLabel?: string;
  definitionKey?: string;
  usesConnection?: boolean;
  agentWriteAllowed?: true;
  branchPorts?: BranchPorts;
  findRowsTable?: Pick<DataTableFindConfig, 'table' | 'tableId'>;
}>;

type GraphLabel = Readonly<{
  step: StepLabel;
  order: number;
  root: boolean;
}>;

export function graphLabels(
  graph: WorkflowGraphContract | undefined,
  describe: DescribeStep,
): ReadonlyMap<string, GraphLabel> {
  const labels = new Map<string, GraphLabel>();
  let order = 0;
  const visit = ({
    current,
    root,
  }: Readonly<{ current: WorkflowGraphContract; root: boolean }>) => {
    for (const node of current.nodes) {
      // The catalog's name for the step type, the same words Build uses.
      const kind = describe(node.definition).name;
      const label = node.label?.trim();
      const ports = branchPorts(node);
      const binding = workflowDataTableBinding(node);
      const connected = {
        ...(ports === undefined ? {} : { branchPorts: ports }),
        definitionKey: node.definition.key,
        ...(binding?.find === true ? { findRowsTable: binding.config } : {}),
        ...(agentToolAllowedWithoutApproval(node) === undefined
          ? {}
          : { agentWriteAllowed: true as const }),
        ...(Object.keys(node.connectionRefs).length > 0
          ? { usesConnection: true }
          : {}),
      };
      labels.set(node.id, {
        step:
          label === undefined || label === ''
            ? { label: kind, ...connected }
            : { label, kindLabel: kind, ...connected },
        order: order++,
        root,
      });
      if (node.structured?.kind === 'for_each')
        visit({ current: node.structured.body, root: false });
    }
  };
  if (graph !== undefined) visit({ current: graph, root: true });
  return labels;
}
