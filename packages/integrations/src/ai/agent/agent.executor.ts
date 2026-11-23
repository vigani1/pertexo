import type { AgentConfig } from '@pertexo/workflow-model';
import { AGENT_TOOL_LIMITS } from '@pertexo/workflow-model';
import type { z } from 'zod';
import { registerProviderExecutor } from '../../providers/provider-executor.js';
import type { ModelClient } from '../model-client.js';
import { runAgentTurn } from '../run-model.js';
import type { agentTurnInputSchema } from './agent.definition.js';

export function createAgentExecutor(
  client: ModelClient,
  definition: Readonly<{ key: string; version: number }>,
  now: () => number = Date.now,
) {
  return registerProviderExecutor(definition, undefined, async (invocation) => {
    const { model, tool } = invocation.config as AgentConfig;
    const { prompt, input, history, toolSchema } = invocation.input as z.output<
      typeof agentTurnInputSchema
    >;
    return runAgentTurn(
      {
        client,
        invocation,
        config: {
          mode: 'text',
          model,
          maxOutputTokens: AGENT_TOOL_LIMITS.outputTokens,
        },
        prompt:
          input === undefined
            ? prompt
            : `${prompt}\n\nInput:\n${JSON.stringify(input)}`,
        purpose: 'ai.agent.execute',
        now,
      },
      {
        tools: [
          {
            name: tool.alias,
            description: tool.description,
            inputSchema: toolSchema,
          },
        ],
        history,
      },
    );
  });
}
