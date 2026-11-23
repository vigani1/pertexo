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

export function validateClassifyCategoryEdit(
  categories: readonly ClassifyCategory[],
  category: ClassifyCategory,
  field: 'label' | 'description',
  text: string,
) {
  const others = categories.filter(({ id }) => id !== category.id);
  // Put the edited row last so the schema assigns a duplicate label to it.
  const parsed = classifyCategoriesSchema.safeParse([
    ...others,
    { ...category, [field]: text },
  ]);
  const value = parsed.data?.at(-1)?.[field];
  if (value !== undefined) return { ok: true, value } as const;
  const problem = parsed.error?.issues.find(
    ({ path }) => path[0] === others.length && path[1] === field,
  );
  if (problem?.code === 'too_small')
    return { ok: false, reason: 'empty' } as const;
  if (problem?.code === 'too_big')
    return { ok: false, reason: 'too_long' } as const;
  if (problem?.code === 'custom')
    return { ok: false, reason: 'duplicate' } as const;
  return { ok: false, reason: 'invalid' } as const;
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
