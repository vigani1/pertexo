import { z } from 'zod';
import { parseBoundedRetryAfterMillis } from '../http/retry-after.js';

import type {
  SecureHttpClient,
  SecureHttpRequest,
} from '../http/secure-http.js';
import {
  SLACK_SEND_MESSAGE_LIMITS,
  slackChannelIdSchema,
  slackMessageTimestampSchema,
} from './validation.js';

export const SLACK_API_ENDPOINTS = Object.freeze({
  authTest: 'https://slack.com/api/auth.test',
  sendMessage: 'https://slack.com/api/chat.postMessage',
});

const slackErrorSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_]+$/u);
const slackResponseSchema = z
  .object({
    ok: z.boolean(),
    channel: slackChannelIdSchema.optional(),
    ts: slackMessageTimestampSchema.optional(),
    error: slackErrorSchema.optional(),
  })
  .strip();

export type SlackApiResult =
  | Readonly<{ kind: 'succeeded'; channelId: string; messageTs: string }>
  | Readonly<{ kind: 'rejected'; error: string }>
  | Readonly<{ kind: 'rate_limited'; retryAfterMillis: number }>
  | Readonly<{ kind: 'http_failure'; status: number }>
  | Readonly<{ kind: 'invalid_response' }>;

type SlackApiFailure = Exclude<SlackApiResult, { kind: 'succeeded' }>;
type SlackAcceptedEnvelope = Readonly<{
  kind: 'accepted';
  channelId?: string;
  messageTs?: string;
}>;
type SlackEnvelopeResult = SlackApiFailure | SlackAcceptedEnvelope;

export type SlackClient = Readonly<{
  sendMessage(
    input: Readonly<{
      botToken: string;
      channelId: string;
      text: string;
      timeoutMillis: number;
      signal: AbortSignal;
      beforeDispatch(): Promise<void>;
    }>,
  ): Promise<SlackApiResult>;
  authTest(
    input: Readonly<{
      botToken: string;
      timeoutMillis: number;
      signal?: AbortSignal;
      beforeDispatch(): Promise<void>;
    }>,
  ): Promise<
    | Exclude<SlackApiResult, { kind: 'succeeded' }>
    | Readonly<{ kind: 'succeeded' }>
  >;
}>;

export function createSlackClient(
  httpClient: Pick<SecureHttpClient, 'execute'>,
): SlackClient {
  const execute = async (
    endpoint: string,
    token: string,
    body: Uint8Array | undefined,
    timeoutMillis: number,
    signal: AbortSignal | undefined,
    beforeDispatch: () => Promise<void>,
  ): Promise<SlackEnvelopeResult> => {
    const request: SecureHttpRequest = {
      url: endpoint,
      method: 'POST',
      headers: Object.freeze({
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      }),
      ...(body === undefined ? {} : { body }),
      timeoutMillis,
      maxRedirects: 0,
      maxResponseBytes: SLACK_SEND_MESSAGE_LIMITS.maxResponseBytes,
      sensitiveValues: [token],
      ...(signal === undefined ? {} : { signal }),
      beforeDispatch,
    };
    const response = await httpClient.execute(request);
    try {
      if (response.status === 429)
        return Object.freeze({
          kind: 'rate_limited',
          retryAfterMillis: parseBoundedRetryAfterMillis(
            response.headers['retry-after'],
            SLACK_SEND_MESSAGE_LIMITS.maxRetryAfterMillis,
          ),
        });
      if (response.status < 200 || response.status > 299)
        return Object.freeze({ kind: 'http_failure', status: response.status });
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(response.body),
        );
      } catch {
        return Object.freeze({ kind: 'invalid_response' });
      }
      const parsed = slackResponseSchema.safeParse(decoded);
      if (!parsed.success) return Object.freeze({ kind: 'invalid_response' });
      if (!parsed.data.ok)
        return parsed.data.error === undefined
          ? Object.freeze({ kind: 'invalid_response' })
          : Object.freeze({ kind: 'rejected', error: parsed.data.error });
      return Object.freeze({
        kind: 'accepted',
        ...(parsed.data.channel === undefined
          ? {}
          : { channelId: parsed.data.channel }),
        ...(parsed.data.ts === undefined ? {} : { messageTs: parsed.data.ts }),
      });
    } finally {
      response.body.fill(0);
    }
  };

  return Object.freeze({
    sendMessage: async (input) => {
      const body = new TextEncoder().encode(
        JSON.stringify({
          channel: input.channelId,
          text: input.text,
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
      try {
        const result = await execute(
          SLACK_API_ENDPOINTS.sendMessage,
          input.botToken,
          body,
          input.timeoutMillis,
          input.signal,
          input.beforeDispatch,
        );
        if (result.kind !== 'accepted') return result;
        if (result.channelId === undefined || result.messageTs === undefined)
          return Object.freeze({ kind: 'invalid_response' });
        return Object.freeze({
          kind: 'succeeded',
          channelId: result.channelId,
          messageTs: result.messageTs,
        });
      } finally {
        body.fill(0);
      }
    },
    authTest: async (input) => {
      const result = await execute(
        SLACK_API_ENDPOINTS.authTest,
        input.botToken,
        undefined,
        input.timeoutMillis,
        input.signal,
        input.beforeDispatch,
      );
      return result.kind === 'accepted'
        ? Object.freeze({ kind: 'succeeded' as const })
        : result;
    },
  });
}
