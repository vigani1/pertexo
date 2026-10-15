import FormData from 'form-data';
import { ARTIFACT_INPUT_MAX_BYTES } from '@pertexo/node-sdk';
import {
  FileInputFailure,
  type NodeArtifactRuntime,
} from '@pertexo/node-sdk/server';
import type { HttpRequestInput } from '../validation.js';
import type { HttpMultipartConfig } from './validation.js';
import { multipartValues } from './values.js';
import { collectMultipart } from './collect.js';

type BufferedPart = Readonly<{
  name: string;
  bytes: Buffer;
  filename?: string;
  contentType: string;
}>;
export async function encodeMultipart(
  input: Readonly<{
    config: HttpMultipartConfig;
    values: HttpRequestInput;
    artifacts: NodeArtifactRuntime | undefined;
    signal: AbortSignal;
  }>,
): Promise<Readonly<{ body: Uint8Array; contentType: string }>> {
  input.signal.throwIfAborted();
  const values = multipartValues(input.config, input.values);
  const parts: BufferedPart[] = [];
  try {
    for (const { part, value } of values) {
      input.signal.throwIfAborted();
      let buffer: Buffer;
      if (typeof value === 'string') buffer = Buffer.from(value, 'utf8');
      else {
        if (input.artifacts?.read === undefined)
          throw new FileInputFailure({ reason: 'file_unavailable' });
        const { kind: _kind, ...reference } = value;
        const bytes = await input.artifacts.read({
          reference,
          maxBytes: ARTIFACT_INPUT_MAX_BYTES,
          signal: input.signal,
        });
        buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
      const filename =
        part.filename ?? (part.kind === 'file' ? 'file' : undefined);
      parts.push({
        name: part.name,
        bytes: buffer,
        ...(filename === undefined ? {} : { filename }),
        contentType:
          part.contentType ??
          (typeof value === 'string'
            ? 'text/plain; charset=utf-8'
            : value.mediaType),
      });
    }
    input.signal.throwIfAborted();
    for (let attempt = 0; attempt < 3; attempt++) {
      const form = new FormData();
      const boundary = form.getBoundary();
      if (parts.some((part) => part.bytes.includes(boundary))) continue;
      for (const part of parts)
        form.append(part.name, part.bytes, {
          ...(part.filename === undefined ? {} : { filename: part.filename }),
          contentType: part.contentType,
          knownLength: part.bytes.byteLength,
        });
      const length = form.getLengthSync();
      if (length > ARTIFACT_INPUT_MAX_BYTES)
        throw new FileInputFailure({ reason: 'multipart_size' });
      const body = await collectMultipart(form, length, input.signal);
      return { body, contentType: `multipart/form-data; boundary=${boundary}` };
    }
    throw new FileInputFailure({ reason: 'multipart_boundary' });
  } finally {
    for (const part of parts) part.bytes.fill(0);
  }
}
