import { z } from 'zod';

export const connectionIdentifierSchema = z.uuid();
export const connectionSecretVersionIdentifierSchema = z.uuid();
export const connectionProviderKeySchema = z.literal('http');
export const connectionAuthTypeSchema = z.literal('http_headers');
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
  .refine((value) => !/[\r\n\0]/u.test(value), {
    message: 'header values cannot contain control delimiters',
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
      bytes += utf8ByteLength(name) + utf8ByteLength(value);
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
    type: connectionAuthTypeSchema,
    headers: httpHeaderCredentialSchema,
  })
  .strict()
  .readonly();

export const connectionCreateRequestSchema = z
  .object({
    providerKey: connectionProviderKeySchema,
    name: connectionNameSchema,
    credential: httpHeadersCredentialSchema,
  })
  .strict()
  .readonly();

export const connectionRotateSecretRequestSchema = z
  .object({
    expectedSecretVersionId: connectionSecretVersionIdentifierSchema,
    credential: httpHeadersCredentialSchema,
  })
  .strict()
  .readonly();

export const connectionTestRequestSchema = z
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
