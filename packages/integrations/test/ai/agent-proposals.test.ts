import { describe, expect, it } from 'vitest';
import { chatCompletions } from '../../src/ai/chat-completions.js';
import { messages } from '../../src/ai/messages.js';
import type { ModelRequest } from '../../src/ai/model-request.js';

const tool = {
  name: 'read_order',
  description: 'Read an order',
  inputSchema: { type: 'object' },
};
const call = {
  name: 'read_order',
  id: 'provider-correlation-id',
  arguments: { order: '123' },
};
const result = { total: 15 };

const request = (endpoint: ModelRequest['endpoint']): ModelRequest => ({
  endpoint,
  config: { mode: 'text', model: 'fake-model' },
  prompt: 'Summarize the order',
  maxTokens: 64,
  agent: { tools: [tool], history: [{ call, result }] },
});

describe('native Agent proposals', () => {
  it('normalizes a single Chat Completions proposal', () => {
    expect(
      chatCompletions.completion(
        {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  {
                    type: 'function',
                    id: call.id,
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.arguments),
                    },
                  },
                ],
              },
            },
          ],
        },
        request('openai'),
      ),
    ).toEqual({ kind: 'proposal', call });
  });

  it('refuses multiple Messages tool proposals', () => {
    const proposal = {
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.arguments,
    };
    expect(
      messages.completion(
        {
          stop_reason: 'tool_use',
          content: [proposal, { ...proposal, id: 'another-id' }],
        },
        request('anthropic'),
      ),
    ).toEqual({ kind: 'invalid_response' });
  });

  it('sends the correlated tool result when continuing a Messages turn', () => {
    expect(messages.request(request('anthropic')).messages).toEqual([
      { role: 'user', content: 'Summarize the order' },
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
    ]);
  });

  it('refuses more than one Chat Completions choice for an Agent turn', () => {
    const choice = {
      finish_reason: 'stop',
      message: { content: 'Final answer' },
    };
    expect(
      chatCompletions.completion(
        {
          choices: [choice, choice],
        },
        request('openai'),
      ),
    ).toEqual({ kind: 'invalid_response' });
  });
});
