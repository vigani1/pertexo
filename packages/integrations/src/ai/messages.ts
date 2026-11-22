import { modelUsageReader } from './model-usage.js';
import { z } from 'zod';
import { normalizeAgentProposal } from './agent/agent-request.js';
import type { ModelRequest } from './model-request.js';

const OUTPUT_TOOL = 'return_output';
const envelope = z.object({
  stop_reason: z.string(),
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      name: z.string().optional(),
      id: z.unknown().optional(),
      input: z.unknown().optional(),
    }),
  ),
});

export const messages = {
  path: 'messages',
  request({ config, prompt, maxTokens, agent }: ModelRequest) {
    return {
      model: config.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'user', content: prompt },
        ...(agent?.history.flatMap(({ call, result }) => [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.arguments,
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: call.id,
                content: JSON.stringify(result),
              },
            ],
          },
        ]) ?? []),
      ],
      ...(agent === undefined
        ? {}
        : {
            tools: agent.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
            tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          }),
      ...(config.mode === 'structured'
        ? {
            tools: [{ name: OUTPUT_TOOL, input_schema: config.outputSchema }],
            tool_choice: {
              type: 'tool',
              name: OUTPUT_TOOL,
              disable_parallel_tool_use: true,
            },
          }
        : {}),
    };
  },
  usage: modelUsageReader('input_tokens', 'output_tokens'),
  completion(value: unknown, request: ModelRequest) {
    const result = envelope.safeParse(value);
    if (!result.success) return { kind: 'invalid_response' } as const;
    const { stop_reason: stop, content } = result.data;
    if (stop === 'max_tokens') return { kind: 'output_truncated' } as const;
    if (stop === 'refusal') return { kind: 'output_refused' } as const;
    if (request.agent !== undefined && stop === 'tool_use') {
      const tools = content.filter(({ type }) => type === 'tool_use');
      const [tool] = tools;
      return tools.length === 1 && tool !== undefined
        ? normalizeAgentProposal({
            id: tool.id,
            name: tool.name,
            arguments: tool.input,
          })
        : ({ kind: 'invalid_response' } as const);
    }
    if (request.config.mode === 'structured') {
      const tools = content.filter(({ type }) => type === 'tool_use');
      const [tool] = tools;
      return stop === 'tool_use' &&
        tools.length === 1 &&
        tool?.name === OUTPUT_TOOL &&
        tool.input !== undefined
        ? ({ kind: 'structured', data: tool.input } as const)
        : ({ kind: 'invalid_response' } as const);
    }
    const text = content
      .filter(({ type }) => type === 'text')
      .map((block) => block.text);
    return stop === 'end_turn' &&
      text.length > 0 &&
      text.every((part) => part !== undefined)
      ? ({ kind: 'text', text: text.join('') } as const)
      : ({ kind: 'invalid_response' } as const);
  },
} as const;
