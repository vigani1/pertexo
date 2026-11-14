import { utf8ByteLength } from '@pertexo/workflow-model';
import { z } from 'zod';
import {
  HTTP_HEADER_LIMITS,
  isSupportedHttpFieldValue as isSerializableHttpHeaderValue,
} from '@pertexo/contracts';

/** A step's own configured headers: how many, and their bytes together. */
const CONFIGURED_HEADER_LIMITS = Object.freeze({
  headers: 64,
  totalBytes: 32_768,
});

const headerNameSchema = z
  .string()
  .min(1)
  .max(HTTP_HEADER_LIMITS.nameCharacters)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
const headerValueSchema = z
  .string()
  .min(1)
  .max(HTTP_HEADER_LIMITS.valueCharacters)
  .refine(isSerializableHttpHeaderValue);
const blockedConfiguredHeaders = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'idempotency-key',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const blockedCredentialHeaders = new Set([
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
export const credentialLikeHeader =
  /(?:auth|credential|secret|token|api[-_]?key)/iu;
function safeConfiguredHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    !blockedConfiguredHeaders.has(normalized) &&
    !credentialLikeHeader.test(normalized)
  );
}
export const httpRequestHeadersSchema = z
  .record(headerNameSchema, headerValueSchema)
  .superRefine((headers, context) => {
    const names = Object.keys(headers);
    if (names.length > CONFIGURED_HEADER_LIMITS.headers)
      context.addIssue({ code: 'custom', message: 'too many headers' });
    const normalized = new Set<string>();
    let bytes = 0;
    for (const [name, value] of Object.entries(headers)) {
      const canonicalName = name.toLowerCase();
      bytes += utf8ByteLength(`${canonicalName}:${value}\r\n`);
      if (normalized.has(canonicalName))
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'header names must be case-insensitively unique',
        });
      if (!safeConfiguredHeader(canonicalName))
        context.addIssue({
          code: 'custom',
          path: [name],
          message:
            'credential-bearing and transport headers are not configurable',
        });
      normalized.add(canonicalName);
    }
    if (bytes > CONFIGURED_HEADER_LIMITS.totalBytes)
      context.addIssue({
        code: 'custom',
        message: 'headers exceed byte limit',
      });
  });
export const resolvedHttpHeadersCredentialSchema = z
  .object({
    type: z.literal('http_headers'),
    headers: z
      .record(headerNameSchema, headerValueSchema)
      .superRefine((headers, context) => {
        const entries = Object.entries(headers);
        if (
          entries.length < 1 ||
          entries.length > HTTP_HEADER_LIMITS.credentialHeaders
        )
          context.addIssue({
            code: 'custom',
            message: 'credential header count is invalid',
          });
        const normalized = new Set<string>();
        let bytes = 0;
        for (const [name, value] of entries) {
          const canonicalName = name.toLowerCase();
          bytes += utf8ByteLength(`${canonicalName}:${value}\r\n`);
          if (
            normalized.has(canonicalName) ||
            blockedCredentialHeaders.has(canonicalName)
          )
            context.addIssue({
              code: 'custom',
              path: [name],
              message: 'credential header is invalid',
            });
          normalized.add(canonicalName);
        }
        if (bytes > HTTP_HEADER_LIMITS.credentialHeaderBytes)
          context.addIssue({
            code: 'custom',
            message: 'credential headers exceed byte limit',
          });
      })
      .transform((headers) =>
        Object.freeze(
          Object.fromEntries(
            Object.entries(headers)
              .map(([name, value]) => [name.toLowerCase(), value] as const)
              .sort(([left], [right]) => left.localeCompare(right)),
          ),
        ),
      ),
  })
  .strict();
