import { COLLECTION_MAX_ITEMS } from '../lists/semantics/validation.js';
import {
  STORED_EXECUTION_VALUE_LIMITS,
  storedExecutionJsonStringBytes,
  StoredExecutionValueInvalidError,
} from '@pertexo/node-sdk';
import {
  canonicalizeBoundedJson,
  NodeExecutorFailure,
  type JsonValue,
} from '@pertexo/node-sdk/server';

export function refuseUtility(code: string, summary: string): never {
  throw new NodeExecutorFailure({
    kind: 'failed',
    errorKind: 'configuration',
    possiblyDispatched: false,
    safeErrorCode: `utility.${code}`,
    errorSummary: summary,
  });
}

export function boundedUtilityResult(value: unknown): JsonValue {
  let admitted: JsonValue;
  try {
    admitted = canonicalizeBoundedJson(value, {
      bytes: STORED_EXECUTION_VALUE_LIMITS.inlineBytes,
      depth: STORED_EXECUTION_VALUE_LIMITS.depth,
      members: STORED_EXECUTION_VALUE_LIMITS.members,
    });
  } catch {
    return refuseUtility(
      'result_too_large',
      `The result exceeds the retained step-data limits (${String(STORED_EXECUTION_VALUE_LIMITS.inlineBytes / 1_024)} KB, depth ${String(STORED_EXECUTION_VALUE_LIMITS.depth)} and ${STORED_EXECUTION_VALUE_LIMITS.members.toLocaleString('en-US')} members). Split the input into smaller batches.`,
    );
  }
  try {
    assertRetainedResult(admitted);
  } catch (error) {
    if (!(error instanceof StoredExecutionValueInvalidError)) throw error;
    return refuseUtility(
      'result_text',
      'The result contains text that cannot be retained. Remove NUL or invalid Unicode characters.',
    );
  }
  return admitted;
}

function assertRetainedResult(admitted: JsonValue): void {
  const pending = [admitted];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string') storedExecutionJsonStringBytes(item);
    else if (item !== null && typeof item === 'object') {
      if (Array.isArray(item) && item.length > COLLECTION_MAX_ITEMS)
        refuseUtility(
          'too_many_items',
          `A result list exceeds ${COLLECTION_MAX_ITEMS.toLocaleString('en-US')} items. Split the input into smaller batches.`,
        );
      for (const [key, child] of Object.entries<JsonValue>(item)) {
        if (!Array.isArray(item)) storedExecutionJsonStringBytes(key);
        pending.push(child);
      }
    }
  }
}
