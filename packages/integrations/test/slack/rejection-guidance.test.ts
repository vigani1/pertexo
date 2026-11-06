import { expect, it } from 'vitest';
import {
  createSlackSendMessageExecutorRegistration,
  createSlackClient,
} from '../../src/server.js';
import { runtime, invocation } from '../support/slack-execution.js';

it.each([
  ['token_expired', 'authentication', /expired/iu],
  ['missing_scope', 'provider', /scope/iu],
  ['not_in_channel', 'provider', /channel/iu],
] as const)(
  'explains the definite Slack %s refusal without claiming a sent message',
  async (error, errorKind, reason) => {
    const state = runtime({ kind: 'rejected', error });
    const result: unknown = await createSlackSendMessageExecutorRegistration({
      client: { sendMessage: state.sendMessage },
    })
      .execute(invocation(state.value))
      .catch((caught: unknown) => caught);
    expect(result).toMatchObject({
      kind: 'failed',
      errorKind,
      possiblyDispatched: false,
      safeErrorCode: `slack.${error}`,
      errorSummary: expect.stringMatching(reason),
    });
    if (error === 'token_expired')
      expect(state.value.observeConnectionHealth).toHaveBeenCalledWith({
        kind: 'reauthorization_required',
        reasonCode: 'connection.slack_token_expired',
      });
  },
);
it.each([429, 200])(
  'recognizes a Slack rate-limit response in HTTP %i',
  async (status) => {
    const client = createSlackClient({
      execute: async (request) => ({
        status,
        headers: { 'retry-after': '3' },
        body: new TextEncoder().encode(
          status === 429
            ? 'limited'
            : JSON.stringify({ ok: false, error: 'ratelimited' }),
        ),
        bodyEncoding: 'utf8',
        finalUrl: request.url,
        redirectCount: 0,
      }),
    });
    expect(
      await client.sendMessage({
        botToken: 'xoxb-fake',
        channelId: 'C123ABC',
        text: 'hello',
        timeoutMillis: 1000,
        signal: new AbortController().signal,
        beforeDispatch: async () => undefined,
      }),
    ).toEqual({ kind: 'rate_limited', retryAfterMillis: 3000 });
  },
);
