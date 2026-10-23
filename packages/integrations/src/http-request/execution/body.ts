import { Buffer } from 'node:buffer';

import { JSON_MEDIA_TYPE } from '../../http/content-type.js';
import {
  type JsonValue,
  type NodeVerifiedByteSource,
  type NodeExecutionInvocation,
  canonicalizeBoundedJson,
} from '@pertexo/node-sdk/server';
import type { HttpOutcomeDecision } from '../../http/outcome-policy.js';
import type { SecureHttpClient } from '../../http/secure.js';

import { safeInstanceOf } from '../../http/unknown-error.js';

import { HttpRequestExecutorError } from './contract.js';

// Leaves room in the step's 1 MiB, 10,000-member output for the text and
// headers the parsed value sits beside.
const PARSED_JSON_LIMITS = Object.freeze({
  bytes: 262_144,
  depth: 48,
  members: 8_000,
});

/** A JSON response later steps can map into; absent when it doesn't fit. */
function parsedJson(text: string): Readonly<{ json?: JsonValue }> {
  try {
    return {
      json: canonicalizeBoundedJson(JSON.parse(text), PARSED_JSON_LIMITS),
    };
  } catch {
    return {};
  }
}

function inlineBody(
  bytes: Uint8Array,
  preferred: 'base64' | 'utf8',
  mediaType: string | undefined,
) {
  if (preferred === 'utf8') {
    let value: string | undefined;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Invalid text is represented exactly as base64.
    }
    if (value !== undefined)
      return Object.freeze({
        kind: 'inline' as const,
        encoding: 'utf8' as const,
        value,
        byteLength: bytes.byteLength,
        ...(mediaType !== undefined && JSON_MEDIA_TYPE.test(mediaType)
          ? parsedJson(value)
          : {}),
      });
  }
  return Object.freeze({
    kind: 'inline' as const,
    encoding: 'base64' as const,
    value: Buffer.from(bytes).toString('base64'),
    byteLength: bytes.byteLength,
  });
}

async function releaseRequestBody(
  body: Uint8Array | NodeVerifiedByteSource | undefined,
): Promise<void> {
  if (body instanceof Uint8Array) body.fill(0);
  else await body?.release();
}

async function writeArtifact(
  artifacts: NonNullable<
    NodeExecutionInvocation<unknown, unknown>['runtime']
  >['artifacts'],
  body: AsyncIterable<Uint8Array>,
  mediaType: string,
  maxBytes: number,
  signal: AbortSignal,
  repeatable: boolean,
  cancelSource?: (reason: Error) => void,
) {
  const failure: HttpOutcomeDecision = repeatable
    ? Object.freeze({
        kind: 'retry',
        errorKind: 'provider',
        reuseProviderKey: false,
      })
    : Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' });
  if (artifacts === undefined)
    throw new HttpRequestExecutorError(failure, true);
  let reference;
  try {
    reference = await artifacts.write({
      body,
      maxBytes,
      mediaType,
      purpose: 'node-output',
      signal,
      ...(cancelSource === undefined ? {} : { cancelSource }),
    });
  } catch (error) {
    throw new HttpRequestExecutorError(failure, true, error);
  }
  return Object.freeze({ kind: 'artifact' as const, ...reference });
}

function concatenate(chunks: readonly Uint8Array[], byteLength: number) {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

type BodyFailure = Readonly<{ error: unknown; failed: boolean }>;

const NO_BODY_FAILURE: BodyFailure = Object.freeze({
  error: undefined,
  failed: false,
});

async function preserveBodyFailureDuringCleanup(
  primary: BodyFailure,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (cleanupError) {
    if (primary.failed)
      throw new AggregateError(
        [primary.error, cleanupError],
        'HTTP response body failed and its iterator cleanup was incomplete',
      );
    throw safeInstanceOf(cleanupError, Error)
      ? cleanupError
      : new Error('HTTP response body cleanup failed', {
          cause: cleanupError,
        });
  }
}

async function* continueBody(
  buffered: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
  markCleanupStarted: () => void,
): AsyncGenerator<Uint8Array> {
  let primary: BodyFailure = NO_BODY_FAILURE;
  try {
    for (const chunk of buffered) {
      try {
        yield chunk;
      } finally {
        chunk.fill(0);
      }
    }
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      const chunk = next.value;
      try {
        yield chunk;
      } finally {
        chunk.fill(0);
      }
    }
  } catch (error) {
    primary = { error, failed: true };
    throw error;
  } finally {
    markCleanupStarted();
    await preserveBodyFailureDuringCleanup(primary, async () => {
      await iterator.return?.();
    });
  }
}

export async function consumeResponseBody(
  artifacts: NonNullable<
    NodeExecutionInvocation<unknown, unknown>['runtime']
  >['artifacts'],
  inlineLimit: number,
  maxBytes: number,
  response: Parameters<Parameters<SecureHttpClient['executeStreaming']>[1]>[0],
  repeatable: boolean,
) {
  const iterator = response.body[Symbol.asyncIterator]();
  const buffered: Uint8Array[] = [];
  let byteLength = 0;
  const bodyOwnership = { cleanupStarted: false };
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        const bytes = concatenate(buffered, byteLength);
        try {
          return inlineBody(
            bytes,
            response.bodyEncoding,
            response.headers['content-type'],
          );
        } finally {
          bytes.fill(0);
          for (const chunk of buffered) chunk.fill(0);
        }
      }
      const chunk = next.value;
      buffered.push(chunk);
      byteLength += chunk.byteLength;
      if (byteLength > inlineLimit) {
        return await writeArtifact(
          artifacts,
          continueBody(buffered, iterator, () => {
            bodyOwnership.cleanupStarted = true;
          }),
          response.headers['content-type'] ?? 'application/octet-stream',
          maxBytes,
          response.signal,
          repeatable,
          response.cancelSource,
        );
      }
    }
  } catch (error: unknown) {
    for (const chunk of buffered) chunk.fill(0);
    if (!bodyOwnership.cleanupStarted)
      await preserveBodyFailureDuringCleanup(
        { error, failed: true },
        async () => {
          bodyOwnership.cleanupStarted = true;
          await iterator.return?.();
        },
      );
    throw error;
  }
}

export async function releaseHttpMaterial(
  body: Uint8Array | NodeVerifiedByteSource | undefined,
  secret: Uint8Array | undefined,
  repeatable: boolean,
  possiblyDispatched: boolean,
): Promise<void> {
  try {
    await releaseRequestBody(body);
  } catch (error) {
    if (!repeatable && possiblyDispatched)
      throw new HttpRequestExecutorError(
        { kind: 'outcome_unknown', errorKind: 'provider' },
        true,
      );
    throw error;
  } finally {
    secret?.fill(0);
  }
}
