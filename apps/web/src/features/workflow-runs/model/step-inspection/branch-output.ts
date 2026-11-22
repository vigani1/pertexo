import type {
  WorkflowGraphContract,
  WorkflowRunData,
} from '@pertexo/contracts';
import { portName } from '@/features/catalog/public';
import {
  CLASSIFY_OTHER_PORT,
  isClassifyDefinition,
  isGuardrailsDefinition,
  GUARDRAILS_PORTS,
  isCoreSwitchDefinition,
  isRecord,
  parallelConfigSchema,
  switchConfigSchema,
} from '@pertexo/workflow-model';

export type BranchPorts = Readonly<{
  field: 'selectedPort' | 'branchIds';
  labels: ReadonlyMap<string, string>;
}>;

/** Branch names come from the graph the run executed. */
export function branchPorts(
  node: WorkflowGraphContract['nodes'][number],
): BranchPorts | undefined {
  if (isGuardrailsDefinition(node.definition))
    return {
      field: 'selectedPort',
      labels: new Map(GUARDRAILS_PORTS.map((port) => [port, portName(port)])),
    };
  if (isClassifyDefinition(node.definition)) {
    const labels = new Map([[CLASSIFY_OTHER_PORT, 'Other']]);
    // Older data can still identify a category even if its label is blank.
    const { categories } = node.config;
    if (Array.isArray(categories)) {
      for (const [index, category] of categories.entries()) {
        if (!isRecord(category) || typeof category.id !== 'string') continue;
        const label =
          typeof category.label === 'string' ? category.label.trim() : '';
        labels.set(category.id, label || portName(category.id, index));
      }
    }
    return { field: 'selectedPort', labels };
  }
  if (isCoreSwitchDefinition(node.definition)) {
    const parsed = switchConfigSchema.safeParse(node.config);
    const labels = new Map([['default', portName('default')]]);
    parsed.data?.cases.forEach(({ id }, index) => {
      labels.set(id, portName(id, index));
    });
    return { field: 'selectedPort', labels };
  }
  if (
    node.definition.key === 'core.parallel' &&
    node.definition.version === 1
  ) {
    const parsed = parallelConfigSchema.safeParse(node.config);
    if (parsed.success)
      return {
        field: 'branchIds',
        labels: new Map(
          parsed.data.branches.map(({ id }) => [id, portName(id)]),
        ),
      };
  }
  return undefined;
}

export function outputBranches(
  data: WorkflowRunData,
  ports: BranchPorts | undefined,
) {
  if (ports === undefined || data.kind !== 'inline' || !isRecord(data.value))
    return [];
  const selected = data.value[ports.field];
  const ids = Array.isArray(selected) ? selected : [selected];
  return ids.flatMap((id: unknown) => {
    if (typeof id !== 'string') return [];
    return [{ id, label: ports.labels.get(id) ?? id }];
  });
}
