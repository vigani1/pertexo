import { z } from 'zod';

import { isSupportedHttpFieldValue } from './http-field-value.js';

export const connectionIdentifierSchema = z.uuid();
export const connectionSecretVersionIdentifierSchema = z.uuid();
export const connectionProviderKeySchema = z.enum(['http', 'slack', 'email']);
export const connectionAuthTypeSchema = z.enum([
  'http_headers',
  'slack_bot_token',
  'resend_api_key',
]);
export const connectionStatusSchema = z.enum([
  'active',
  'reauthorization_required',
  'revoked',
]);

const connectionNameSchema = z.string().trim().min(1).max(128);
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

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

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
    schemaVersion: z.literal(1),
    type: z.literal('http_headers'),
    headers: httpHeaderCredentialSchema,
  })
  .strict()
  .readonly();

export const slackBotTokenCredentialSchema = z
  .object({
    schemaVersion: z.literal(1),
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
    schemaVersion: z.literal(1),
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

export const connectionCredentialSchema = z.discriminatedUnion('type', [
  httpHeadersCredentialSchema,
  slackBotTokenCredentialSchema,
  resendApiKeyCredentialSchema,
]);

export const connectionCreateRequestSchema = z.discriminatedUnion(
  'providerKey',
  [
    z
      .object({
        providerKey: z.literal('http'),
        name: connectionNameSchema,
        credential: httpHeadersCredentialSchema,
      })
      .strict()
      .readonly(),
    z
      .object({
        providerKey: z.literal('email'),
        name: connectionNameSchema,
        credential: resendApiKeyCredentialSchema,
      })
      .strict()
      .readonly(),
    z
      .object({
        providerKey: z.literal('slack'),
        name: connectionNameSchema,
        credential: slackBotTokenCredentialSchema,
      })
      .strict()
      .readonly(),
  ],
);

export const connectionRotateSecretRequestSchema = z
  .object({
    expectedSecretVersionId: connectionSecretVersionIdentifierSchema,
    credential: connectionCredentialSchema,
  })
  .strict()
  .readonly();

const httpConnectionTestRequestSchema = z
  .object({
    url: z
      .url()
      .max(2_048)
      .refine(
        (value) => utf8ByteLength(value) <= 2_048,
        'URL exceeds byte limit',
      )
      .refine(
        (value) =>
          /^https:\/\/[^/?#@]+(?:[/?]|$)/u.test(value) && !value.includes('#'),
        'connection tests require an HTTPS URL without credentials or a fragment',
      ),
  })
  .strict()
  .readonly();

const slackConnectionTestRequestSchema = z
  .object({ providerKey: z.literal('slack') })
  .strict()
  .readonly();

const emailConnectionTestRequestSchema = z
  .object({
    providerKey: z.literal('email'),
    sideEffectDisclosureAccepted: z.literal(true),
  })
  .strict()
  .readonly();

export const connectionTestRequestSchema = z.union([
  httpConnectionTestRequestSchema,
  slackConnectionTestRequestSchema,
  emailConnectionTestRequestSchema,
]);

export const connectionResponseSchema = z
  .object({
    id: connectionIdentifierSchema,
    workspaceId: z.uuid(),
    providerKey: connectionProviderKeySchema,
    name: connectionNameSchema,
    authType: connectionAuthTypeSchema,
    status: connectionStatusSchema,
    secretVersionId: connectionSecretVersionIdentifierSchema,
    health: z
      .object({
        lastTestedAt: z.iso.datetime().nullable(),
        lastHealthyAt: z.iso.datetime().nullable(),
        lastErrorCode: z.string().min(1).max(128).nullable(),
      })
      .strict()
      .readonly(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export const connectionTestOutcomeSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      httpStatus: z.number().int().min(100).max(599),
      errorCode: z.null(),
    })
    .strict()
    .readonly(),
  z
    .object({
      ok: z.literal(false),
      httpStatus: z.number().int().min(100).max(599).nullable(),
      errorCode: z.string().min(1).max(128),
    })
    .strict()
    .readonly(),
]);

export const connectionTestResponseSchema = z
  .object({
    connection: connectionResponseSchema,
    outcome: connectionTestOutcomeSchema,
  })
  .strict()
  .readonly();

export const connectionIdParamSchema = z
  .object({ workspaceId: z.uuid(), connectionId: connectionIdentifierSchema })
  .strict()
  .readonly();

export type ConnectionCreateRequest = z.input<
  typeof connectionCreateRequestSchema
>;
export type ParsedConnectionCreateRequest = z.output<
  typeof connectionCreateRequestSchema
>;
export type ConnectionRotateSecretRequest = z.input<
  typeof connectionRotateSecretRequestSchema
>;
export type ParsedConnectionRotateSecretRequest = z.output<
  typeof connectionRotateSecretRequestSchema
>;
export type ConnectionTestRequest = z.input<typeof connectionTestRequestSchema>;
export type ParsedConnectionTestRequest = z.output<
  typeof connectionTestRequestSchema
>;
export type ConnectionResponse = z.output<typeof connectionResponseSchema>;
export type ConnectionTestResponse = z.output<
  typeof connectionTestResponseSchema
>;
