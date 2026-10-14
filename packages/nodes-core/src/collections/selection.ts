import {
  parseJsonPath,
  resolveJsonPath,
  type JsonValue,
} from '@pertexo/workflow-model';
import {
  NodeExecutionAbortedError,
  NodeInputValidationError,
} from '@pertexo/node-sdk/server';

export function checkCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new NodeExecutionAbortedError();
}
export function invalidInput(reason: string): never {
  throw new NodeInputValidationError(reason);
}
export function* projectItems(
  items: readonly JsonValue[],
  path: string,
  signal: AbortSignal,
) {
  // The registry admitted this path through collectionPathSchema.
  const segments = parseJsonPath(path) as readonly (string | number)[];
  for (const [ordinal, item] of items.entries()) {
    checkCanceled(signal);
    const selected = resolveJsonPath(item, segments);
    yield {
      item,
      ordinal,
      value: selected.kind === 'value' ? selected.value : undefined,
    };
  }
}
