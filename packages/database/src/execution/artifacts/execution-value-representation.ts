import {
  parseStoredExecutionValueV1,
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
    return reference;
  } catch (error) {
    if (error instanceof StoredExecutionValueInvalidError) return undefined;
    throw error;
  }
}
