import { modelUsageReader } from './model-usage.js';
import { z } from 'zod';
import type { ModelRequest } from './model-request.js';

const OUTPUT_TOOL = 'return_output';
const envelope = z.object({
  stop_reason: z.string(),
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      name: z.string().optional(),
      input: z.unknown().optional(),
    }),
  ),
});

export const messages = {
  path: 'messages',
  request({ config, prompt, maxTokens }: ModelRequest) {
    return {
      model: config.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
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
  completion(value: unknown, mode: ModelRequest['config']['mode']) {
    const result = envelope.safeParse(value);
    if (!result.success) return { kind: 'invalid_response' } as const;
    const { stop_reason: stop, content } = result.data;
    if (stop === 'max_tokens') return { kind: 'output_truncated' } as const;
    if (stop === 'refusal') return { kind: 'output_refused' } as const;
    if (mode === 'structured') {
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
