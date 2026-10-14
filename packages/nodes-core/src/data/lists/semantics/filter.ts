import type {
  CoreFilterConfig,
  CoreFilterInput,
} from '../filter/validation.js';
import type { JsonValue } from '@pertexo/workflow-model';
import { invalidInput, projectItems } from './selection.js';

function matches(
  value: JsonValue | undefined,
  comparison: CoreFilterInput['value'],
  operator: CoreFilterConfig['operator'],
): boolean {
  if (operator === 'exists') return value !== undefined;
  if (operator === 'not_exists') return value === undefined;
  if (value === undefined) return false;
  if (value !== null && typeof value === 'object')
    return invalidInput('Filter comparison requires a scalar item value');
  if (operator === 'equals') return value === comparison;
  if (operator === 'not_equals') return value !== comparison;
  if (operator === 'contains') {
    if (typeof value !== 'string')
      return invalidInput('Filter contains requires text values');
    return value.includes(comparison as string);
  }
  if (typeof value !== 'number')
    return invalidInput('Filter numeric comparison requires numbers');
  const number = comparison as number;
  switch (operator) {
    case 'less_than':
      return value < number;
    case 'less_or_equal':
      return value <= number;
    case 'greater_than':
      return value > number;
    case 'greater_or_equal':
      return value >= number;
  }
}
export function filterItems(
  config: CoreFilterConfig,
  input: CoreFilterInput,
  signal: AbortSignal,
) {
  if (
    config.operator !== 'exists' &&
    config.operator !== 'not_exists' &&
    input.value === undefined
  )
    return invalidInput('Filter comparison value is required');
  if (config.operator === 'contains' && typeof input.value !== 'string')
    return invalidInput('Filter contains requires text values');
  if (
    ['less_than', 'less_or_equal', 'greater_than', 'greater_or_equal'].includes(
      config.operator,
    ) &&
    typeof input.value !== 'number'
  )
    return invalidInput('Filter numeric comparison requires numbers');
  const items: JsonValue[] = [];
  for (const selected of projectItems(input.items, config.path, signal))
    if (matches(selected.value, input.value, config.operator))
      items.push(selected.item);
  return {
    items,
    inputCount: input.items.length,
    removedCount: input.items.length - items.length,
  };
}
