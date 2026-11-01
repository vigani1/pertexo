import { expect, it } from 'vitest';
import { parseStoredExecutionValue } from '../../../src/runs/values/stored-execution.js';
import {
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from '@pertexo/node-sdk';

const remaining = STORED_EXECUTION_VALUE_LIMITS.members - 2;
const leftCount = Math.floor(remaining / 2);
const rightCount = remaining - leftCount;

it('accepts the exact member budget spread across sibling containers', () => {
  const value = {
    left: Array.from({ length: leftCount }, () => null),
    right: Array.from({ length: rightCount }, () => null),
  };
  expect(parseStoredExecutionValue({ kind: 'inline', value })).toEqual({
    kind: 'inline',
    value,
  });
});

it('rejects cumulative overflow even when each sibling fits separately', () => {
  const value = {
    left: Array.from({ length: leftCount }, () => null),
    right: Array.from({ length: rightCount + 1 }, () => null),
  };
  expect(() => parseStoredExecutionValue({ kind: 'inline', value })).toThrow(
    StoredExecutionValueInvalidError,
  );
});
