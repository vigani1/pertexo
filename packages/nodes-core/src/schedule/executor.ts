import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_SCHEDULE_DEFINITION,
  CORE_SCHEDULE_DEFINITION_V2,
  CORE_SCHEDULE_DEFINITION_V3,
  CORE_SCHEDULE_EXECUTOR,
  CORE_SCHEDULE_EXECUTOR_V2,
  CORE_SCHEDULE_EXECUTOR_V3,
} from './definition.js';

export const coreScheduleExecutor: NodeExecutorRegistration = Object.freeze({
  abiVersion: 1,
  definitions: Object.freeze([CORE_SCHEDULE_DEFINITION]),
  executor: CORE_SCHEDULE_EXECUTOR,
  lifecycle: 'active',
  policyReferences: Object.freeze([CORE_BOUNDED_JSON_POLICY]),
  execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
    Promise.resolve(invocation.input),
});

export const coreScheduleExecutorV2: NodeExecutorRegistration = Object.freeze({
  ...coreScheduleExecutor,
  definitions: Object.freeze([CORE_SCHEDULE_DEFINITION_V2]),
  executor: CORE_SCHEDULE_EXECUTOR_V2,
});

export const coreScheduleExecutorV3: NodeExecutorRegistration = Object.freeze({
  ...coreScheduleExecutor,
  definitions: Object.freeze([CORE_SCHEDULE_DEFINITION_V3]),
  executor: CORE_SCHEDULE_EXECUTOR_V3,
});
