import { RUN_VALUE_LIMITS } from '@pertexo/node-sdk';

export class RunValuesLimitError extends Error {
  override readonly name = 'RunValuesLimitError';
  constructor() {
    super(
      `A run can keep at most ${String(RUN_VALUE_LIMITS.pairs)} distinct values. Reuse an existing key or save fewer values.`,
    );
  }
}
