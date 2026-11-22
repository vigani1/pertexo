import { modelUsageReader } from './model-usage.js';
import { z } from 'zod';
import { normalizeAgentProposal } from './agent/agent-request.js';
import type { ModelRequest } from './model-request.js';

const messageSchema = z.object({
  content: z.string().nullable(),
  refusal: z.string().nullish(),
});
const choice = z.object({
  finish_reason: z.string(),
  message: messageSchema,
});
const envelope = z.object({ choices: z.tuple([choice]).rest(choice) });
const agentChoice = choice.extend({
  message: messageSchema.extend({
    content: messageSchema.shape.content.optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string(),
          type: z.literal('function'),
          function: z.object({ name: z.string(), arguments: z.string() }),
        }),
      )
      .optional(),
  }),
});
const agentEnvelope = z.object({ choices: z.tuple([agentChoice]) });

export const chatCompletions = {
  path: 'chat/completions',
  request({ config, prompt, maxTokens, endpoint, agent }: ModelRequest) {
    return {
      model: config.model,
      ...(endpoint === 'openai'
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
      messages: [
        { role: 'user', content: prompt },
        ...(agent?.history.flatMap(({ call, result }) => [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          },
        ]) ?? []),
      ],
      ...(agent === undefined
        ? {}
        : {
            tools: agent.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
            parallel_tool_calls: false,
          }),
      ...(config.mode === 'structured' && endpoint !== 'openrouter'
        ? { response_format: { type: 'json_object' } }
        : {}),
    };
  },
  usage: modelUsageReader('prompt_tokens', 'completion_tokens'),
  completion(value: unknown, request: ModelRequest) {
    if (request.agent !== undefined) return agentCompletion(value);
    const result = envelope.safeParse(value);
    if (!result.success) return { kind: 'invalid_response' } as const;
    return textCompletion(result.data.choices[0]);
  },
} as const;

function agentCompletion(value: unknown) {
  const result = agentEnvelope.safeParse(value);
  if (!result.success) return { kind: 'invalid_response' } as const;
  const choice = result.data.choices[0];
  const { finish_reason: finish, message } = choice;
  const [call] = message.tool_calls ?? [];
  if (finish === 'stop' && call !== undefined && !message.refusal)
    return { kind: 'invalid_response' } as const;
  if (finish !== 'tool_calls' || message.refusal) return textCompletion(choice);
  if (message.tool_calls?.length !== 1 || call === undefined)
    return { kind: 'invalid_response' } as const;
  try {
    return normalizeAgentProposal({
      id: call.id,
      name: call.function.name,
      arguments: JSON.parse(call.function.arguments) as unknown,
    });
  } catch {
    return { kind: 'invalid_response' } as const;
  }
}

function textCompletion({
  finish_reason: finish,
  message,
}: {
  finish_reason: string;
  message: {
    content?: string | null | undefined;
    refusal?: string | null | undefined;
  };
}) {
  if (finish === 'length') return { kind: 'output_truncated' } as const;
  if (finish === 'content_filter' || message.refusal)
    return { kind: 'output_refused' } as const;
  return finish === 'stop' && typeof message.content === 'string'
    ? ({ kind: 'text', text: message.content } as const)
    : ({ kind: 'invalid_response' } as const);
}
