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
  conversationsInfo: 'https://slack.com/api/conversations.info',
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
/** ADR 046: only the requested conversation's identity and display name. */
const slackConversationResponseSchema = z
  .object({
    ok: z.boolean(),
    channel: z
      .object({
        id: slackChannelIdSchema,
        name: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[\p{L}\p{N}\p{M}._-]+$/u),
      })
      .strip()
      .optional(),
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
type SlackEnvelope = Readonly<{ ok: boolean; error?: string | undefined }>;
type SlackEnvelopeResult<Envelope> =
  SlackApiFailure | Readonly<{ kind: 'accepted'; envelope: Envelope }>;
type SlackRequestBody = Readonly<{ bytes: Uint8Array; contentType: string }>;

export type SlackChannelLookupResult =
  | Readonly<{ kind: 'succeeded'; channelId: string; name: string }>
  | SlackApiFailure;

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
  ): Promise<SlackApiFailure | Readonly<{ kind: 'succeeded' }>>;
  /** ADR 046: one read-only `conversations.info` name lookup. */
  lookupChannel(
    input: Readonly<{
      botToken: string;
      channelId: string;
      timeoutMillis: number;
      signal?: AbortSignal;
      beforeDispatch(): Promise<void>;
    }>,
  ): Promise<SlackChannelLookupResult>;
}>;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function createSlackClient(
  httpClient: Pick<SecureHttpClient, 'execute'>,
): SlackClient {
  const execute = async <Envelope extends SlackEnvelope>(
    endpoint: string,
    token: string,
    body: SlackRequestBody | undefined,
    schema: z.ZodType<Envelope>,
    options: Readonly<{
      timeoutMillis: number;
      signal?: AbortSignal | undefined;
      beforeDispatch: () => Promise<void>;
    }>,
  ): Promise<SlackEnvelopeResult<Envelope>> => {
    const request: SecureHttpRequest = {
      url: endpoint,
      method: 'POST',
      headers: Object.freeze({
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': body?.contentType ?? JSON_CONTENT_TYPE,
      }),
      ...(body === undefined ? {} : { body: body.bytes }),
      timeoutMillis: options.timeoutMillis,
      maxRedirects: 0,
      maxResponseBytes: SLACK_SEND_MESSAGE_LIMITS.maxResponseBytes,
      sensitiveValues: [token],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      beforeDispatch: options.beforeDispatch,
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
      const parsed = schema.safeParse(decoded);
      if (!parsed.success) return Object.freeze({ kind: 'invalid_response' });
      if (!parsed.data.ok)
        return parsed.data.error === undefined
          ? Object.freeze({ kind: 'invalid_response' })
          : Object.freeze({ kind: 'rejected', error: parsed.data.error });
      return Object.freeze({ kind: 'accepted', envelope: parsed.data });
    } finally {
      response.body.fill(0);
    }
  };

  return Object.freeze({
    sendMessage: async (input) => {
      const bytes = new TextEncoder().encode(
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
          { bytes, contentType: JSON_CONTENT_TYPE },
          slackResponseSchema,
          input,
        );
        if (result.kind !== 'accepted') return result;
        const { channel, ts } = result.envelope;
        if (channel === undefined || ts === undefined)
          return Object.freeze({ kind: 'invalid_response' });
        return Object.freeze({
          kind: 'succeeded',
          channelId: channel,
          messageTs: ts,
        });
      } finally {
        bytes.fill(0);
      }
    },
    authTest: async (input) => {
      const result = await execute(
        SLACK_API_ENDPOINTS.authTest,
        input.botToken,
        undefined,
        slackResponseSchema,
        input,
      );
      return result.kind === 'accepted'
        ? Object.freeze({ kind: 'succeeded' as const })
        : result;
    },
    lookupChannel: async (input) => {
      // conversations.info is a form-encoded read method.
      const bytes = new TextEncoder().encode(
        new URLSearchParams({ channel: input.channelId }).toString(),
      );
      try {
        const result = await execute(
          SLACK_API_ENDPOINTS.conversationsInfo,
          input.botToken,
          { bytes, contentType: 'application/x-www-form-urlencoded' },
          slackConversationResponseSchema,
          input,
        );
        if (result.kind !== 'accepted') return result;
        const { channel } = result.envelope;
        if (channel?.id !== input.channelId)
          return Object.freeze({ kind: 'invalid_response' });
        return Object.freeze({
          kind: 'succeeded',
          channelId: channel.id,
          name: channel.name,
        });
      } finally {
        bytes.fill(0);
      }
    },
  });
}
