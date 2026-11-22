import {
  CLASSIFY_OTHER_PORT,
  classifyCategoriesSchema,
  classifyOutputPorts,
  type ClassifyCategory,
} from '@pertexo/workflow-model';
import type { WorkflowEdge, WorkflowNode } from './graph/scopes';

export function readClassifyCategories(
  config: WorkflowNode['config'],
): readonly ClassifyCategory[] | undefined {
  if (config.categories === undefined) return [];
  const parsed = classifyCategoriesSchema.safeParse(config.categories);
  return parsed.success ? parsed.data : undefined;
}

export function classifyPortLabels(
  config: WorkflowNode['config'],
): Readonly<Record<string, string>> {
  return {
    ...Object.fromEntries(
      (readClassifyCategories(config) ?? []).map(({ id, label }) => [
        id,
        label,
      ]),
    ),
    [CLASSIFY_OTHER_PORT]: 'Other',
  };
}

export function removeDeletedCategoryLinks(
  edges: readonly WorkflowEdge[],
  nodeId: string,
  previous: WorkflowNode['config'],
  next: WorkflowNode['config'],
): readonly WorkflowEdge[] {
  const before = readClassifyCategories(previous);
  const after = readClassifyCategories(next);
  if (before === undefined || after === undefined) return edges;
  const currentPorts = new Set(classifyOutputPorts(after));
  const removed = new Set(
    classifyOutputPorts(before).filter((port) => !currentPorts.has(port)),
  );
  return removed.size === 0
    ? edges
    : edges.filter(
        ({ source }) => source.nodeId !== nodeId || !removed.has(source.port),
      );
}
