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
    body: Uint8Array,
    timeoutMillis: number,
    signal: AbortSignal,
    beforeDispatch: () => Promise<void>,
  ): Promise<SlackApiResult> => {
    const request: SecureHttpRequest = {
      url: endpoint,
      method: 'POST',
      headers: Object.freeze({
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      }),
      body,
      timeoutMillis,
      maxRedirects: 0,
      maxResponseBytes: SLACK_SEND_MESSAGE_LIMITS.maxResponseBytes,
      sensitiveValues: [token],
      signal,
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
      if (parsed.data.channel === undefined || parsed.data.ts === undefined)
        return Object.freeze({ kind: 'invalid_response' });
      return Object.freeze({
        kind: 'succeeded',
        channelId: parsed.data.channel,
        messageTs: parsed.data.ts,
      });
    } finally {
      response.body.fill(0);
    }
  };

  return Object.freeze({
    sendMessage: (input) => {
      const body = new TextEncoder().encode(
        JSON.stringify({
          channel: input.channelId,
          text: input.text,
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
      return execute(
        SLACK_API_ENDPOINTS.sendMessage,
        input.botToken,
        body,
        input.timeoutMillis,
        input.signal,
        input.beforeDispatch,
      ).finally(() => body.fill(0));
    },
    authTest: async (input) => {
      const response = await httpClient.execute({
        url: SLACK_API_ENDPOINTS.authTest,
        method: 'POST',
        headers: Object.freeze({
          accept: 'application/json',
          authorization: `Bearer ${input.botToken}`,
          'content-type': 'application/json; charset=utf-8',
        }),
        timeoutMillis: input.timeoutMillis,
        maxRedirects: 0,
        maxResponseBytes: SLACK_SEND_MESSAGE_LIMITS.maxResponseBytes,
        sensitiveValues: [input.botToken],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        beforeDispatch: input.beforeDispatch,
      });
      try {
        if (response.status === 429)
          return Object.freeze({
            kind: 'rate_limited' as const,
            retryAfterMillis: parseBoundedRetryAfterMillis(
              response.headers['retry-after'],
              SLACK_SEND_MESSAGE_LIMITS.maxRetryAfterMillis,
            ),
          });
        if (response.status < 200 || response.status > 299)
          return Object.freeze({
            kind: 'http_failure' as const,
            status: response.status,
          });
        let decoded: unknown;
        try {
          decoded = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(response.body),
          );
        } catch {
          return Object.freeze({ kind: 'invalid_response' as const });
        }
        const parsed = slackResponseSchema.safeParse(decoded);
        if (!parsed.success)
          return Object.freeze({ kind: 'invalid_response' as const });
        if (parsed.data.ok)
          return Object.freeze({ kind: 'succeeded' as const });
        return parsed.data.error === undefined
          ? Object.freeze({ kind: 'invalid_response' as const })
          : Object.freeze({
              kind: 'rejected' as const,
              error: parsed.data.error,
            });
      } finally {
        response.body.fill(0);
      }
    },
  });
}
