import { Buffer } from 'node:buffer';

import {
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { z } from 'zod';

import {
  classifySecureHttpError,
  classifySecureHttpResponse,
  HTTP_SIDE_EFFECT_CLASS,
  type HttpOutcomeDecision,
} from '../http/outcome-policy.js';
import { SecureHttpError, type SecureHttpClient } from '../http/secure-http.js';
import {
  HTTP_REQUEST_CONNECTION_SLOT,
  HTTP_REQUEST_DEFINITION,
  HTTP_REQUEST_EXECUTOR,
  HTTP_REQUEST_NETWORK_POLICY,
  HTTP_REQUEST_VALUE_POLICY,
} from './definition.js';
import {
  HTTP_REQUEST_LIMITS,
  httpRequestConfigSchema,
  httpRequestInputSchema,
  httpRequestOutputSchema,
  type HttpRequestOutput,
} from './validation.js';

const credentialHeaderNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
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
const resolvedCredentialSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('http_headers'),
    headers: z
      .record(
        credentialHeaderNameSchema,
        z
          .string()
          .min(1)
          .max(8_192)
          .refine((value) => !/[\r\n\0]/u.test(value)),
      )
      .superRefine((headers, context) => {
        const entries = Object.entries(headers);
        if (entries.length < 1 || entries.length > 32)
          context.addIssue({
            code: 'custom',
            message: 'credential header count is invalid',
          });
        const normalized = new Set<string>();
        let bytes = 0;
        for (const [name, value] of entries) {
          const canonicalName = name.toLowerCase();
          bytes += new TextEncoder().encode(
            `${canonicalName}:${value}\r\n`,
          ).byteLength;
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
        if (bytes > 16_384)
          context.addIssue({
            code: 'custom',
            message: 'credential headers exceed byte limit',
          });
      })
      .transform((headers) =>
        Object.freeze(
          Object.fromEntries(
            Object.entries(headers).map(([name, value]) => [
              name.toLowerCase(),
              value,
            ]),
          ),
        ),
      ),
  })
  .strict();

export class HttpRequestExecutorError extends Error {
  public override readonly name = 'HttpRequestExecutorError';

  public constructor(
    public readonly decision: HttpOutcomeDecision,
    public readonly possiblyDispatched: boolean,
  ) {
    super(`HTTP Request execution failed: ${decision.kind}`);
  }
}

export type HttpRequestExecutorDependencies = Readonly<{
  httpClient: Pick<SecureHttpClient, 'execute'>;
}>;

function failedConfiguration(): HttpRequestExecutorError {
  return new HttpRequestExecutorError(
    Object.freeze({ kind: 'failed', errorKind: 'configuration' }),
    false,
  );
}

function requestBody(
  input: z.output<typeof httpRequestInputSchema>,
  method: z.output<typeof httpRequestConfigSchema>['method'],
): Uint8Array | undefined {
  if (input.body === undefined) return undefined;
  if (method === 'GET' || method === 'HEAD') throw failedConfiguration();
  if (input.body.encoding === 'utf8') {
    const bytes = new TextEncoder().encode(input.body.value);
    if (bytes.byteLength > HTTP_REQUEST_LIMITS.maxRequestBodyBytes)
      throw failedConfiguration();
    return bytes;
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      input.body.value,
    )
  )
    throw failedConfiguration();
  const bytes = Buffer.from(input.body.value, 'base64');
  if (
    bytes.byteLength > HTTP_REQUEST_LIMITS.maxRequestBodyBytes ||
    bytes.toString('base64') !== input.body.value
  )
    throw failedConfiguration();
  return new Uint8Array(bytes);
}

function decodeCredential(secret: Uint8Array) {
  try {
    return resolvedCredentialSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret)),
    );
  } catch {
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
      false,
    );
  }
}

function mergeHeaders(
  configured: Readonly<Record<string, string>>,
  credential: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const normalizedConfigured = Object.fromEntries(
    Object.entries(configured).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  if (
    Object.keys(credential).some((name) =>
      Object.hasOwn(normalizedConfigured, name),
    )
  )
    throw failedConfiguration();
  return Object.freeze({ ...normalizedConfigured, ...credential });
}

function inlineBody(bytes: Uint8Array, preferred: 'base64' | 'utf8') {
  if (preferred === 'utf8') {
    try {
      return Object.freeze({
        kind: 'inline' as const,
        encoding: 'utf8' as const,
        value: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        byteLength: bytes.byteLength,
      });
    } catch {
      // Invalid text is represented exactly as base64.
    }
  }
  return Object.freeze({
    kind: 'inline' as const,
    encoding: 'base64' as const,
    value: Buffer.from(bytes).toString('base64'),
    byteLength: bytes.byteLength,
  });
}

async function executeHttpRequest(
  dependencies: HttpRequestExecutorDependencies,
  invocation: NodeExecutionInvocation<unknown, unknown>,
): Promise<HttpRequestOutput> {
  const config = httpRequestConfigSchema.parse(invocation.config);
  const input = httpRequestInputSchema.parse(invocation.input);
  const runtime = invocation.runtime;
  if (
    runtime?.connections === undefined ||
    runtime.sideEffectClass !== 'unsafe' ||
    runtime.providerIdempotencyKey !== undefined ||
    Object.keys(invocation.connectionRefs).length !== 1
  )
    throw failedConfiguration();
  const connectionId = invocation.connectionRefs[HTTP_REQUEST_CONNECTION_SLOT];
  if (connectionId === undefined) throw failedConfiguration();
  const target = new URL(config.url);
  if (target.protocol !== 'https:') throw failedConfiguration();

  let resolved;
  try {
    resolved = await runtime.connections.resolve({
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers',
      purpose: 'http.request.execute',
      signal: invocation.signal,
    });
  } catch {
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
      false,
    );
  }
  let body: Uint8Array | undefined;
  try {
    if (
      resolved.connectionId !== connectionId ||
      resolved.providerKey !== 'http' ||
      resolved.authType !== 'http_headers'
    )
      throw failedConfiguration();
    const credential = decodeCredential(resolved.secret);
    body = requestBody(input, config.method);
    let response;
    try {
      response = await dependencies.httpClient.execute({
        url: config.url,
        method: config.method,
        headers: mergeHeaders(config.headers, credential.headers),
        ...(body === undefined ? {} : { body }),
        timeoutMillis: config.timeoutMillis,
        maxRedirects: config.maxRedirects,
        maxResponseBytes: config.maxResponseBytes,
        sensitiveValues: Object.values(credential.headers),
        signal: invocation.signal,
        beforeDispatch: () => runtime.beforeDispatch(),
      });
    } catch (error: unknown) {
      if (!(error instanceof SecureHttpError))
        throw new HttpRequestExecutorError(
          Object.freeze({ kind: 'outcome_unknown', errorKind: 'network' }),
          true,
        );
      throw new HttpRequestExecutorError(
        classifySecureHttpError(error, HTTP_SIDE_EFFECT_CLASS.unsafe, false),
        error.possiblyDispatched,
      );
    }
    try {
      const decision = classifySecureHttpResponse(
        response.status,
        HTTP_SIDE_EFFECT_CLASS.unsafe,
        false,
      );
      if (decision.kind !== 'succeeded')
        throw new HttpRequestExecutorError(decision, true);
      const outputBody =
        response.body.byteLength <= config.inlineResponseBytes
          ? inlineBody(response.body, response.bodyEncoding)
          : await writeArtifact(runtime.artifacts, response, invocation.signal);
      return httpRequestOutputSchema.parse({
        status: response.status,
        headers: response.headers,
        body: outputBody,
        finalOrigin: response.finalUrl,
        redirectCount: response.redirectCount,
      });
    } finally {
      response.body.fill(0);
    }
  } finally {
    body?.fill(0);
    resolved.secret.fill(0);
  }
}

async function writeArtifact(
  artifacts: NonNullable<
    NodeExecutionInvocation<unknown, unknown>['runtime']
  >['artifacts'],
  response: Awaited<ReturnType<SecureHttpClient['execute']>>,
  signal: AbortSignal,
) {
  if (artifacts === undefined)
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'internal' }),
      true,
    );
  let reference;
  try {
    reference = await artifacts.write({
      bytes: response.body,
      mediaType: response.headers['content-type'] ?? 'application/octet-stream',
      purpose: 'node-output',
      signal,
    });
  } catch {
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'internal' }),
      true,
    );
  }
  return Object.freeze({ kind: 'artifact' as const, ...reference });
}

export function createHttpRequestExecutorRegistration(
  dependencies: HttpRequestExecutorDependencies,
  lifecycle: NodeExecutorRegistration['lifecycle'] = 'staged',
): NodeExecutorRegistration {
  return Object.freeze({
    abiVersion: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
    definitions: Object.freeze([HTTP_REQUEST_DEFINITION]),
    executor: HTTP_REQUEST_EXECUTOR,
    lifecycle,
    policyReferences: Object.freeze([
      HTTP_REQUEST_NETWORK_POLICY,
      HTTP_REQUEST_VALUE_POLICY,
    ]),
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
      executeHttpRequest(dependencies, invocation),
  });
}
