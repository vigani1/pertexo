import { describe, expect, it, vi } from 'vitest';
import { prepareInlineWorkflowExecutionValueV3 } from '../src/execution/artifacts/execution-value-representation.js';
import { STORED_EXECUTION_VALUE_LIMITS_V1 } from '../src/execution/stored-execution-value.js';

describe('V3 framework inline representation selection', () => {
  it('keeps the retained source-local inline byte bound and independent snapshot', () => {
    const overhead = JSON.stringify({ value: '' }).length;
    const value = {
      value: 'a'.repeat(
        STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes - overhead,
      ),
    };
    const reference = prepareInlineWorkflowExecutionValueV3(value);
    expect(reference).toEqual({ schemaVersion: 1, kind: 'inline', value });
    value.value = 'changed';
    expect(reference?.value).not.toEqual(value);
    expect(Object.isFrozen(reference?.value)).toBe(true);
    expect(
      prepareInlineWorkflowExecutionValueV3({
        value: 'a'.repeat(
          STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes + 1 - overhead,
        ),
      }),
    ).toBeUndefined();
  });

  it('returns no inline representation for JSON strings PostgreSQL cannot store', () => {
    expect(
      prepareInlineWorkflowExecutionValueV3({ value: '\u0000' }),
    ).toBeUndefined();
  });

  it('does not evaluate hostile values or claim invalid data was admitted', () => {
    const getter = vi.fn(() => 'secret');
    const value = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: getter,
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const input of [value, cycle, NaN, undefined])
      expect(prepareInlineWorkflowExecutionValueV3(input)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });
});
