import {
  callableObjectTypeDescriptorSchemaV1,
  type CallableObjectTypeDescriptorV1,
} from '@pertexo/workflow-model/callable-type-contract';
import type { FieldParseResult } from './inspector-draft';

export function formatCallableType(
  value: CallableObjectTypeDescriptorV1,
): string {
  return JSON.stringify(value, null, 2);
}

export function equalCallableTypes(
  left: CallableObjectTypeDescriptorV1,
  right: CallableObjectTypeDescriptorV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Text feedback only; the shared contract owns every descriptor rule. */
export function parseCallableTypeText(
  text: string,
): FieldParseResult<CallableObjectTypeDescriptorV1> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      error: 'That isn’t valid JSON yet. Check for a missing quote or brace.',
    };
  }
  const result = callableObjectTypeDescriptorSchemaV1.safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        error:
          'Use a closed object with properties and required names. Check the supported types, property names and size limits below.',
      };
}
