import type { RunValues } from '@pertexo/node-sdk';
import type { ExecutionCapabilityScope } from '../../attempts/dispatch/execution-capability.types.js';
export type RunValuesSaveInput = ExecutionCapabilityScope &
  Readonly<{ values: RunValues; signal: AbortSignal }>;
export class RunValuesLimitError extends Error {
  override readonly name = 'RunValuesLimitError';
  constructor() {
    super(
      'A run can keep at most ten distinct values. Reuse an existing key or save fewer values.',
    );
  }
}
