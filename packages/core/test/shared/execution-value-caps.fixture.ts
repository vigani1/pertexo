import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';

export function executionValueCaps() {
  let deep: unknown = null;
  for (let depth = 0; depth <= STORED_EXECUTION_VALUE_LIMITS.depth; depth++)
    deep = [deep];
  return [
    ['inline bytes', 'x'.repeat(STORED_EXECUTION_VALUE_LIMITS.inlineBytes)],
    ['depth', deep],
    [
      'members',
      Array.from(
        { length: STORED_EXECUTION_VALUE_LIMITS.members + 1 },
        () => null,
      ),
    ],
  ] as const;
}
