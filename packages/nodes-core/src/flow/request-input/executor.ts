import type { NodeExecutorRegistration } from '@pertexo/node-sdk/server';
import { CORE_REQUEST_INPUT_EXECUTOR } from './definition.js';
export const coreRequestInputExecutor: NodeExecutorRegistration = Object.freeze(
  {
    executor: CORE_REQUEST_INPUT_EXECUTOR,
    execute: () => Promise.resolve({ pending: true }),
  },
);
