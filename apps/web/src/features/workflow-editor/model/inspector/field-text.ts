import { toShownValue } from '@/lib/schema-fields/units';
import {
  parseConfigJson,
  parseNumberField,
  type FieldParseResult,
  type NodeConfig,
  type SchemaFieldSpec,
} from './draft';
import { parseItemPath } from './item-path';

type FieldValue = NodeConfig[string] | undefined;

/** The text a typed field shows for a stored value, in its shown unit. */
export function formatFieldText(
  field: SchemaFieldSpec,
  value: FieldValue,
): string {
  if (field.kind === 'json-object')
    return value === undefined ? '' : JSON.stringify(value, null, 2);
  if (field.kind === 'integer' || field.kind === 'number')
    return typeof value === 'number'
      ? String(toShownValue(value, field.unit, field.maximum))
      : '';
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

/** What a typed field stores for its text, or why it can't. */
export function parseFieldText(
  field: SchemaFieldSpec,
  text: string,
): FieldParseResult<FieldValue> {
  if (field.kind === 'json-object') {
    if (text.trim() === '')
      return field.required
        ? { ok: false, error: `${field.label} is required.` }
        : { ok: true, value: undefined };
    return parseConfigJson(text, field.label);
  }
  if (field.kind === 'integer' || field.kind === 'number')
    return parseNumberField(field, text);
  if (field.format !== 'json-path')
    return {
      ok: true,
      value: text === '' && !field.required ? undefined : text,
    };
  if (text.trim() === '' && !field.required)
    return { ok: true, value: undefined };
  return parseItemPath(text);
}

/**
 * What a field stores when a saved value is opened and saved again
 * untouched: a switch keeps only true or false, a select only one of its
 * choices, and a typed field what its shown text reads back as.
 */
export function reopenFieldValue(
  field: SchemaFieldSpec,
  value: FieldValue,
): FieldParseResult<FieldValue> {
  if (field.kind === 'boolean')
    return typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, error: `${field.label} can only be on or off.` };
  if (field.options !== undefined)
    return typeof value === 'string' && field.options.includes(value)
      ? { ok: true, value }
      : { ok: false, error: `${field.label} has no choice for this value.` };
  return parseFieldText(field, formatFieldText(field, value));
}
