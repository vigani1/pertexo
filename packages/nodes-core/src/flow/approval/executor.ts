import type { NodeExecutorRegistration } from '@pertexo/node-sdk/server';
import { CORE_APPROVAL_EXECUTOR } from './definition.js';

/** Only declares the task; the coordinator owns the eventual decision. */
export const coreApprovalExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_APPROVAL_EXECUTOR,
  execute: () => Promise.resolve({ pending: true }),
});
