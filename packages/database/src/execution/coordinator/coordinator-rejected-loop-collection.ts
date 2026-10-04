import type { workflowForEachBoundsV2 } from '@pertexo/workflow-model/graph';
import { parseStoredExecutionValueV1 } from '../stored-execution-value.js';

type Bounds = ReturnType<typeof workflowForEachBoundsV2>;
type IterationPath = readonly Readonly<{
  loopNodeId: string;
  ordinal: number;
}>[];

export function rejectedForEachCollectionCount(
  value: unknown,
): number | undefined {
  try {
    const stored = parseStoredExecutionValueV1({
      schemaVersion: 1,
      kind: 'inline',
      value,
    });
    if (stored.kind !== 'inline') return undefined;
    value = stored.value;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  if (Object.keys(value).sort().join(',') !== 'items,iterationCount')
    return undefined;
  const items: unknown = Reflect.get(value, 'items');
  const count: unknown = Reflect.get(value, 'iterationCount');
  return Array.isArray(items) &&
    Number.isSafeInteger(count) &&
    count === items.length
    ? items.length
    : undefined;
}

/** Callers separately prove attempt ownership and the scope's ancestor ledger. */
export function isRejectedForEachCollection({
  nodeId,
  iterationPath,
  value,
  bounds,
  remainingIterationBudget: remainingBudget,
}: Readonly<{
  nodeId: string;
  iterationPath: IterationPath;
  value: unknown;
  bounds: Bounds;
  remainingIterationBudget: number;
}>): boolean {
  const count = rejectedForEachCollectionCount(value);
  return isRejectedForEachCount({
    nodeId,
    iterationPath,
    count,
    bounds,
    remainingIterationBudget: remainingBudget,
  });
}

/** Same established bound proof; native count comes from fresh original-byte work. */
export function isRejectedForEachCount({
  nodeId,
  iterationPath,
  count,
  bounds,
  remainingIterationBudget: remainingBudget,
}: Readonly<{
  nodeId: string;
  iterationPath: IterationPath;
  count: number | undefined;
  bounds: Bounds;
  remainingIterationBudget: number;
}>): boolean {
  const pin = bounds.get(nodeId);
  return (
    pin !== undefined &&
    count !== undefined &&
    Number.isSafeInteger(count) &&
    count > 0 &&
    Number.isSafeInteger(remainingBudget) &&
    remainingBudget >= 0 &&
    pin.ancestorLoopNodeIds.length === iterationPath.length &&
    iterationPath.every(
      (scope, index) =>
        scope.loopNodeId === pin.ancestorLoopNodeIds[index] &&
        Number.isSafeInteger(scope.ordinal) &&
        scope.ordinal >= 0,
    ) &&
    (count > pin.maxIterations || count > remainingBudget)
  );
}
