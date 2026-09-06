import { z } from 'zod';
import { parseBoundedRetryAfterMillis } from '../http/retry-after.js';

import type {
  SecureHttpClient,
  SecureHttpRequest,
} from '../http/secure-http.js';
import { EMAIL_SEND_NOTIFICATION_LIMITS } from './validation.js';

export const RESEND_API_ENDPOINT = 'https://api.resend.com/emails' as const;

const successSchema = z.object({ id: z.uuid() }).strip();
const errorTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_]+$/u);
const errorSchema = z.object({ name: errorTypeSchema }).strip();

export type ResendApiResult =
  | Readonly<{ kind: 'succeeded'; emailId: string }>
  | Readonly<{ kind: 'rejected'; error: string; status: number }>
  | Readonly<{ kind: 'rate_limited'; retryAfterMillis: number }>
  | Readonly<{ kind: 'http_failure'; status: number }>
  | Readonly<{ kind: 'invalid_response' }>;

export type ResendClient = Readonly<{
  sendNotification(
    input: Readonly<{
      apiKey: string;
      fromEmail: string;
      toEmail: string;
      subject: string;
      text: string;
      idempotencyKey: string;
      timeoutMillis: number;
      signal?: AbortSignal;
      beforeDispatch(): Promise<void>;
    }>,
  ): Promise<ResendApiResult>;
}>;

export function createResendClient(
  httpClient: Pick<SecureHttpClient, 'execute'>,
): ResendClient {
  return Object.freeze({
    sendNotification: async (input) => {
      const body = new TextEncoder().encode(
        JSON.stringify({
          from: input.fromEmail,
          to: [input.toEmail],
          subject: input.subject,
          text: input.text,
        }),
      );
      const request: SecureHttpRequest = {
        url: RESEND_API_ENDPOINT,
        method: 'POST',
        headers: Object.freeze({
          accept: 'application/json',
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json; charset=utf-8',
          'idempotency-key': input.idempotencyKey,
        }),
        body,
        timeoutMillis: input.timeoutMillis,
        maxRedirects: 0,
        maxResponseBytes: EMAIL_SEND_NOTIFICATION_LIMITS.maxResponseBytes,
        sensitiveValues: [input.apiKey],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        beforeDispatch: input.beforeDispatch,
      };
      try {
        const response = await httpClient.execute(request);
        try {
          if (response.status === 429)
            return Object.freeze({
              kind: 'rate_limited' as const,
              retryAfterMillis: parseBoundedRetryAfterMillis(
                response.headers['retry-after'],
                EMAIL_SEND_NOTIFICATION_LIMITS.maxRetryAfterMillis,
              ),
            });
          let decoded: unknown;
          try {
            decoded = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(response.body),
            );
          } catch {
            return Object.freeze({ kind: 'invalid_response' as const });
          }
          if (response.status >= 200 && response.status <= 299) {
            const parsed = successSchema.safeParse(decoded);
            return parsed.success
              ? Object.freeze({
                  kind: 'succeeded' as const,
                  emailId: parsed.data.id,
                })
              : Object.freeze({ kind: 'invalid_response' as const });
          }
          const parsedError = errorSchema.safeParse(decoded);
          return parsedError.success
            ? Object.freeze({
                kind: 'rejected' as const,
                error: parsedError.data.name,
                status: response.status,
              })
            : Object.freeze({
                kind: 'http_failure' as const,
                status: response.status,
              });
        } finally {
          response.body.fill(0);
        }
      } finally {
        body.fill(0);
      }
    },
  });
}
