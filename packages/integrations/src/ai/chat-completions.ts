import { z } from 'zod';
import type { ModelRequest } from './model-request.js';

const choice = z.object({
  finish_reason: z.string(),
  message: z.object({
    content: z.string().nullable(),
    refusal: z.string().nullish(),
  }),
});
const envelope = z.object({ choices: z.tuple([choice]).rest(choice) });

export const chatCompletions = {
  path: 'chat/completions',
  request({ config, prompt, maxTokens, endpoint }: ModelRequest) {
    return {
      model: config.model,
      ...(endpoint === 'openai'
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
      messages: [{ role: 'user', content: prompt }],
      ...(config.mode === 'structured' && endpoint !== 'openrouter'
        ? { response_format: { type: 'json_object' } }
        : {}),
    };
  },
  completion(value: unknown) {
    const result = envelope.safeParse(value);
    if (!result.success) return { kind: 'invalid_response' } as const;
    const { finish_reason: finish, message } = result.data.choices[0];
    if (finish === 'length') return { kind: 'output_truncated' } as const;
    if (finish === 'content_filter' || message.refusal)
      return { kind: 'output_refused' } as const;
    return finish === 'stop' && message.content !== null
      ? ({ kind: 'text', text: message.content } as const)
      : ({ kind: 'invalid_response' } as const);
  },
} as const;
