import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_BOUNDED_JSON_POLICY } from '../policies.js';
import {
  CORE_WORKFLOW_CALL_DEFINITION,
  CORE_WORKFLOW_CALL_EXECUTOR,
  CORE_WORKFLOW_CALL_POLICY,
} from './definition.js';
import {
  CORE_WORKFLOW_CALL_CONFIG_SCHEMA,
  CORE_WORKFLOW_CALL_INPUT_SCHEMA,
} from './validation.js';

/**
 * Pure declaration only: the coordinator interprets this bounded input snapshot
 * through durable call control. It is not a child execution or child result.
 */
export const coreWorkflowCallExecutor: NodeExecutorRegistration = Object.freeze(
  {
    abiVersion: 1,
    definitions: Object.freeze([CORE_WORKFLOW_CALL_DEFINITION]),
    executor: CORE_WORKFLOW_CALL_EXECUTOR,
    lifecycle: 'active',
    policyReferences: Object.freeze([
      CORE_BOUNDED_JSON_POLICY,
      CORE_WORKFLOW_CALL_POLICY,
    ]),
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) => {
      CORE_WORKFLOW_CALL_CONFIG_SCHEMA.parse(invocation.config);
      return Promise.resolve(
        CORE_WORKFLOW_CALL_INPUT_SCHEMA.parse(invocation.input),
      );
    },
  },
);
