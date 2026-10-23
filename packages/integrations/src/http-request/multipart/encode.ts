import FormData from 'form-data';
import type { Readable } from 'node:stream';
import {
  FileInputFailure,
  type NodeArtifactRuntime,
  type NodeVerifiedByteSource,
} from '@pertexo/node-sdk/server';
import { HTTP_REQUEST_LIMITS, type HttpRequestInput } from '../validation.js';
import type { HttpMultipartConfig } from './validation.js';
import { multipartValues } from './values.js';
import { collectMultipart } from './collect.js';

type Part = Readonly<{
  name: string;
  value: Buffer | NodeVerifiedByteSource;
  filename?: string;
  contentType: string;
}>;
async function collides(
  part: Part,
  boundary: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (Buffer.isBuffer(part.value)) return part.value.includes(boundary);
  const stream = part.value.open(signal);
  const needle = Buffer.from(boundary);
  let tail = Buffer.alloc(0);
  try {
    for await (const value of stream) {
      const chunk: unknown = value;
      if (!(chunk instanceof Uint8Array))
        throw new FileInputFailure({ reason: 'multipart_encoding' });
      const bytes = Buffer.concat([tail, chunk]);
      const found = bytes.includes(needle);
      tail.fill(0);
      tail = Buffer.from(
        bytes.subarray(Math.max(0, bytes.byteLength - needle.byteLength + 1)),
      );
      bytes.fill(0);
      chunk.fill(0);
      if (found) return true;
    }
    return false;
  } finally {
    tail.fill(0);
    stream.destroy();
  }
}
export async function encodeMultipart(
  input: Readonly<{
    config: HttpMultipartConfig;
    values: HttpRequestInput;
    artifacts: NodeArtifactRuntime | undefined;
    signal: AbortSignal;
  }>,
): Promise<Readonly<{ body: NodeVerifiedByteSource; contentType: string }>> {
  input.signal.throwIfAborted();
  const values = multipartValues(input.config, input.values);
  const spool = input.artifacts?.spool?.bind(input.artifacts);
  if (spool === undefined)
    throw new FileInputFailure({ reason: 'file_unavailable' });
  const parts: Part[] = [];
  let encoded: NodeVerifiedByteSource | undefined;
  try {
    for (const { part, value } of values) {
      input.signal.throwIfAborted();
      let source: Buffer | NodeVerifiedByteSource;
      if (typeof value === 'string') source = Buffer.from(value, 'utf8');
      else {
        if (input.artifacts?.openVerified === undefined)
          throw new FileInputFailure({ reason: 'file_unavailable' });
        const { kind: _kind, ...reference } = value;
        source = await input.artifacts.openVerified({
          reference,
          maxBytes: HTTP_REQUEST_LIMITS.maxRequestBodyBytes,
          signal: input.signal,
        });
      }
      const filename =
        part.filename ?? (part.kind === 'file' ? 'file' : undefined);
      parts.push({
        name: part.name,
        value: source,
        ...(filename === undefined ? {} : { filename }),
        contentType:
          part.contentType ??
          (typeof value === 'string'
            ? 'text/plain; charset=utf-8'
            : value.mediaType),
      });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      input.signal.throwIfAborted();
      const form = new FormData();
      const boundary = form.getBoundary();
      let collision = false;
      for (const part of parts)
        if (await collides(part, boundary, input.signal)) {
          collision = true;
          break;
        }
      if (collision) {
        form.destroy();
        continue;
      }
      const streams: Readable[] = [];
      try {
        appendMultipartParts(form, parts, input.signal, streams);
        const length = form.getLengthSync();
        if (length > HTTP_REQUEST_LIMITS.maxRequestBodyBytes)
          throw new FileInputFailure({ reason: 'multipart_size' });
        const body = await collectMultipart(form, length, input.signal, spool);
        encoded = body;
        return {
          body,
          contentType: `multipart/form-data; boundary=${boundary}`,
        };
      } finally {
        form.destroy();
        await Promise.all(
          streams.map(async (stream) => {
            if (stream.closed) return;
            const closed = new Promise<void>((resolve) => {
              stream.once('close', resolve);
            });
            stream.destroy();
            await closed;
          }),
        );
      }
    }
    throw new FileInputFailure({ reason: 'multipart_boundary' });
  } finally {
    await releaseParts(parts, encoded);
  }
}

async function releaseParts(
  parts: readonly Part[],
  encoded: NodeVerifiedByteSource | undefined,
): Promise<void> {
  const released = await Promise.allSettled(
    parts.map(async (part) => {
      if (Buffer.isBuffer(part.value)) part.value.fill(0);
      else await part.value.release();
    }),
  );
  const failed = released.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    await encoded?.release();
    throw failed.reason;
  }
}

function appendMultipartParts(
  form: FormData,
  parts: readonly Part[],
  signal: AbortSignal,
  streams: Readable[],
): void {
  for (const part of parts) {
    const value = partBody(part, signal);
    if (!Buffer.isBuffer(value)) streams.push(value);
    form.append(part.name, value, {
      ...(part.filename === undefined ? {} : { filename: part.filename }),
      contentType: part.contentType,
      knownLength: part.value.byteLength,
    });
  }
}

function partBody(part: Part, signal: AbortSignal): Buffer | Readable {
  if (Buffer.isBuffer(part.value)) return part.value;
  if (part.value.byteLength === 0) return Buffer.alloc(0);
  return part.value.open(signal);
}
