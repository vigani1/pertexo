import type { RunValues } from '@pertexo/node-sdk';
import type { ExecutionCapabilityScope } from '../../attempts/dispatch/execution-capability.types.js';
export type RunValuesSaveInput = ExecutionCapabilityScope &
  Readonly<{ values: RunValues; signal: AbortSignal }>;
