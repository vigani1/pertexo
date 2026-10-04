import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { types as nodeTypes } from 'node:util';
import { serializeWorkflowExecutionJsonValueV3 } from '@pertexo/database/execution';
import {
  boundedNodeJsonSchema,
  NODE_JSON_LIMITS_V1,
  type SchemaJson,
} from '@pertexo/node-sdk';
import type { z } from 'zod';
import type { metadataSchema } from './workflow-execution-value-contract.js';

function invalid(message: string): never {
  throw new TypeError(message);
}
function assertActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

export function normalize(value: unknown): SchemaJson {
  if (typeof value === 'object' && value !== null && nodeTypes.isProxy(value))
    invalid('Execution value is not bounded JSON');
  const parsed = boundedNodeJsonSchema.safeParse(value);
  if (!parsed.success) invalid('Execution value is not bounded JSON');
  return parsed.data;
}

/** Decode one bounded owned stream, verify canonical integrity, and clear all byte copies. */
export async function hydrateStream(
  body: Readable,
  metadata: z.infer<typeof metadataSchema>,
  signal: AbortSignal,
): Promise<SchemaJson> {
  const chunks: Buffer[] = [];
  let bytes: Buffer | undefined;
  let byteLength = 0;
  const hash = createHash('sha256');
  async function* boundedChunks(
    source: AsyncIterable<unknown>,
  ): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array))
        invalid('Execution value artifact stream is not bytes');
      try {
        assertActive(signal);
        byteLength += chunk.byteLength;
        if (
          byteLength > NODE_JSON_LIMITS_V1.bytes ||
          byteLength > metadata.byteLength
        )
          invalid('Execution value artifact exceeds its byte limit');
        hash.update(chunk);
        yield Buffer.from(chunk);
      } finally {
        chunk.fill(0);
      }
    }
  }
  try {
    assertActive(signal);
    await pipeline(
      body,
      boundedChunks,
      async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) chunks.push(chunk);
      },
      { signal },
    );
    assertActive(signal);
    if (
      byteLength !== metadata.byteLength ||
      hash.digest('hex') !== metadata.sha256
    )
      invalid('Execution value artifact integrity mismatch');
    bytes = Buffer.concat(chunks, byteLength);
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
      );
    } catch {
      invalid('Execution value artifact is not UTF8 JSON');
    }
    const value = normalize(decoded);
    const canonical = Buffer.from(
      serializeWorkflowExecutionJsonValueV3(value),
      'utf8',
    );
    try {
      if (
        canonical.byteLength !== metadata.byteLength ||
        createHash('sha256').update(canonical).digest('hex') !== metadata.sha256
      )
        invalid('Execution value artifact is not canonical JSON');
    } finally {
      canonical.fill(0);
    }
    return value;
  } finally {
    body.destroy();
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}
