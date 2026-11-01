import { createWebhookResponseStore } from '@pertexo/core/triggers';

import type { CapabilityAssembly } from './contract.js';
import { assertCapabilityRuntimeOpen } from './lifecycle.js';

export function prepareWebhookResponseCapability(
  state: CapabilityAssembly,
): void {
  const webhookResponses =
    state.dependencies.webhookResponses ??
    (state.resources.ownedWebhookResponses = createWebhookResponseStore(
      state.options.database,
      state.dependencies.databaseRuntime,
    ));
  state.factories.webhookResponse = (context) => ({
    respond: async ({ response, signal }) => {
      assertCapabilityRuntimeOpen(state.lifecycle);
      signal.throwIfAborted();
      if (context.previewRunId !== undefined || (context.testRun ?? false))
        return { outcome: 'preview', statusCode: response.statusCode };
      return webhookResponses.respond({
        workspaceId: context.workspaceId,
        runId: context.runId,
        nodeRunId: context.nodeRunId,
        attemptId: context.attemptId,
        attemptNumber: context.attemptNumber,
        nodeId: context.nodeId,
        invocationKey: context.invocationKey,
        workerId: context.workerId,
        fenceToken: context.fenceToken,
        response,
        signal,
      });
    },
  });
}
