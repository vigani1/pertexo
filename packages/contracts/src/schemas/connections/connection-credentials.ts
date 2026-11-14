import { signingKeyCredentialSchema } from '@pertexo/node-sdk';
import { z } from 'zod';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { isSupportedHttpFieldValue } from '../shared/http-field-value.js';
import { oauth2CredentialSchema } from './oauth2-connections.js';

const httpHeaderNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
const httpHeaderValueSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine(isSupportedHttpFieldValue, {
    message: 'header value contains a byte unsupported by HTTP transport',
  });
const prohibitedConnectionHeaders = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'idempotency-key',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const unsafeMailboxCharacters = [
  '(',
  ')',
  ',',
  ':',
  ';',
  '<',
  '>',
  '[',
  ']',
  '"',
  '\\',
] as const;
export const httpHeaderCredentialSchema = z
  .record(httpHeaderNameSchema, httpHeaderValueSchema)
  .superRefine((headers, context) => {
    const names = Object.keys(headers);
    if (names.length < 1 || names.length > 32) {
      context.addIssue({
        code: 'custom',
        message: 'between one and 32 credential headers are required',
      });
    }
    const normalized = new Set<string>();
    let bytes = 0;
    for (const [name, value] of Object.entries(headers)) {
      const canonicalName = name.toLowerCase();
      bytes += utf8ByteLength(`${canonicalName}:${value}\r\n`);
      if (normalized.has(canonicalName)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'credential header names are case-insensitively unique',
        });
      }
      if (prohibitedConnectionHeaders.has(canonicalName)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'this transport-controlled header cannot be a credential',
        });
      }
      normalized.add(canonicalName);
    }
    if (bytes > 16_384) {
      context.addIssue({
        code: 'custom',
        message: 'credential headers exceed the total byte limit',
      });
    }
  })
  .transform((headers) =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(headers)
          .map(([name, value]) => [name.toLowerCase(), value] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  );
export const httpHeadersCredentialSchema = z
  .object({
    type: z.literal('http_headers'),
    headers: httpHeaderCredentialSchema,
  })
  .strict()
  .readonly();
export const slackBotTokenCredentialSchema = z
  .object({
    type: z.literal('slack_bot_token'),
    botToken: z
      .string()
      .min(10)
      .max(512)
      .regex(/^xoxb-[A-Za-z0-9-]+$/u),
  })
  .strict()
  .readonly();
const emailMailboxSchema = z
  .string()
  .min(3)
  .max(254)
  .refine((value) => /^[\x21-\x7e]+$/u.test(value))
  .refine((value) => {
    if (unsafeMailboxCharacters.some((character) => value.includes(character)))
      return false;
    const at = value.indexOf('@');
    if (at < 1 || at !== value.lastIndexOf('@')) return false;
    const local = value.slice(0, at);
    const labels = value.slice(at + 1).split('.');
    return (
      local.length <= 64 &&
      /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u.test(
        local,
      ) &&
      labels.length >= 2 &&
      labels.every((label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label),
      )
    );
  })
  .overwrite((value) => {
    const at = value.indexOf('@');
    return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
  });
export const resendApiKeyCredentialSchema = z
  .object({
    type: z.literal('resend_api_key'),
    apiKey: z
      .string()
      .min(8)
      .max(512)
      .regex(/^re_[A-Za-z0-9_-]+$/u),
    fromEmail: emailMailboxSchema,
  })
  .strict()
  .readonly();
export const smtpCredentialSchema = z
  .object({
    type: z.literal('smtp'),
    host: z.union([z.ipv4(), z.ipv6(), z.hostname().max(253)]),
    port: z.number().int().min(1).max(65535),
    security: z.enum(['implicit', 'starttls', 'none']),
    username: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[^\r\n\0]+$/u),
    password: z.string().min(1).max(4096),
    fromEmail: emailMailboxSchema,
    fromName: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\r\n\0]+$/u)
      .optional(),
  })
  .strict()
  .readonly();
export const connectionCredentialSchema = z.discriminatedUnion('type', [
  signingKeyCredentialSchema,
  httpHeadersCredentialSchema,
  slackBotTokenCredentialSchema,
  resendApiKeyCredentialSchema,
  smtpCredentialSchema,
  oauth2CredentialSchema,
]);
