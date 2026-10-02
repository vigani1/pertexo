import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionValueV1,
  STORED_EXECUTION_VALUE_LIMITS_V1,
  StoredExecutionValueInvalidError,
  type StoredExecutionValueV1,
} from '../stored-execution-value.js';

/**
 * Representation selection only: the framework first admits the value through
 * the independent node JSON policy. This does not make invalid data eligible
 * for artifact persistence or raise the retained inline persistence limit.
 */
export function prepareInlineWorkflowExecutionValueV3(
  value: unknown,
): Extract<StoredExecutionValueV1, { readonly kind: 'inline' }> | undefined {
  try {
    const reference = parseStoredExecutionValueV1({
      schemaVersion: 1,
      kind: 'inline',
      value,
    });
    if (reference.kind !== 'inline')
      throw new TypeError('Inline representation owner returned another kind');
    // Native protected ingress includes the immutable reference wrapper in its
    // inline budget. Keep retained V1 parsing/encoding unchanged.
    if (
      Buffer.byteLength(serializeStoredExecutionValueV1(reference), 'utf8') >
      STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes
    )
      return undefined;
    return reference;
  } catch (error) {
    if (error instanceof StoredExecutionValueInvalidError) return undefined;
    throw error;
  }
}
