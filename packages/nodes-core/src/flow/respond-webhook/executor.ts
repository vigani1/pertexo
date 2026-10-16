import {
  NodeExecutionRuntimeRequiredError,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_RESPOND_WEBHOOK_EXECUTOR } from './definition.js';
import type {
  CoreRespondWebhookConfig,
  CoreRespondWebhookInput,
} from './validation.js';
import { serializeWebhookResponse } from './serialize.js';

export const coreRespondWebhookExecutor: NodeExecutorRegistration =
  Object.freeze({
    executor: CORE_RESPOND_WEBHOOK_EXECUTOR,
    execute: async (invocation: NodeExecutionInvocation<unknown, unknown>) => {
      const response = serializeWebhookResponse(
        invocation.config as CoreRespondWebhookConfig,
        invocation.input as CoreRespondWebhookInput,
      );
      const capability = invocation.runtime?.webhookResponse;
      if (capability === undefined)
        throw new NodeExecutionRuntimeRequiredError();
      return capability.respond({ response, signal: invocation.signal });
    },
  });
