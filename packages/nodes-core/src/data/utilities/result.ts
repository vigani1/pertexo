import { COLLECTION_MAX_ITEMS } from '../lists/semantics/semantics.schemas.js';
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

export const UTILITY_ERROR_CODE = Object.freeze({
  invalid_data: 'utility.invalid_data',
  text_fields: 'utility.text_fields',
  result_text: 'utility.result_text',
  result_too_large: 'utility.result_too_large',
  too_many_items: 'utility.too_many_items',
  xml_name: 'utility.xml_name',
  xml_data: 'utility.xml_data',
  xml_input: 'utility.xml_input',
  xml_root: 'utility.xml_root',
  xml_malformed: 'utility.xml_malformed',
  xml_dtd: 'utility.xml_dtd',
  xml_depth: 'utility.xml_depth',
  xml_size: 'utility.xml_size',
  html_selector: 'utility.html_selector',
  html_depth: 'utility.html_depth',
  html_size: 'utility.html_size',
  crypto_input: 'utility.crypto_input',
  hmac_connection: 'utility.hmac_connection',
  hmac_unavailable: 'utility.hmac_unavailable',
} as const);

export function refuseUtility(
  code: keyof typeof UTILITY_ERROR_CODE,
  summary: string,
): never {
  throw new NodeExecutorFailure({
    kind: 'failed',
    errorKind: 'configuration',
    possiblyDispatched: false,
    safeErrorCode: UTILITY_ERROR_CODE[code],
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
