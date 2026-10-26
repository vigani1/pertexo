import { FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import {
  FileInputFailure,
  type NodeArtifactRuntime,
  type NodeVerifiedByteSource,
} from '@pertexo/node-sdk/server';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { encodedAttachmentBytes } from '../validation.js';
import { EmailAttachmentFailure } from './plan.js';

export type ResendAttachment = Readonly<{
  filename: string;
  contentType: string;
  source: NodeVerifiedByteSource;
}>;

type Spool = NonNullable<NodeArtifactRuntime['spool']>;

async function* base64Chunks(
  source: NodeVerifiedByteSource,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const stream = source.open(signal);
  let carry = Buffer.alloc(0);
  let read = 0;
  try {
    for await (const value of stream) {
      const chunk: unknown = value;
      if (!(chunk instanceof Uint8Array))
        throw new FileInputFailure({ reason: 'file_integrity' });
      read += chunk.byteLength;
      const joined = Buffer.concat([carry, chunk]);
      chunk.fill(0);
      carry.fill(0);
      // Base64 encodes 3 bytes at a time; the remainder waits for the next chunk.
      const whole = joined.byteLength - (joined.byteLength % 3);
      carry = Buffer.from(joined.subarray(whole));
      if (whole > 0)
        yield Buffer.from(
          joined.subarray(0, whole).toString('base64'),
          'ascii',
        );
      joined.fill(0);
    }
    if (read !== source.byteLength)
      throw new FileInputFailure({ reason: 'file_integrity' });
    if (carry.byteLength > 0)
      yield Buffer.from(carry.toString('base64'), 'ascii');
  } finally {
    carry.fill(0);
    stream.destroy();
  }
}

/**
 * The Resend JSON body with each file inlined as base64, written to verified
 * scratch so a large message never sits in memory whole. The length is exact
 * before any byte is read.
 */
export async function encodeMessageWithAttachments(
  input: Readonly<{
    message: Readonly<Record<string, unknown>>;
    attachments: readonly ResendAttachment[];
    spool: Spool;
    signal: AbortSignal;
  }>,
): Promise<NodeVerifiedByteSource> {
  const head = `${JSON.stringify(input.message).slice(0, -1)},"attachments":[`;
  const parts = input.attachments.map((attachment, index) => ({
    open: `${index === 0 ? '' : ','}{"filename":${JSON.stringify(attachment.filename)},"content_type":${JSON.stringify(attachment.contentType)},"content":"`,
    source: attachment.source,
  }));
  const close = '"}';
  const tail = ']}';
  const length = parts.reduce(
    (total, part) =>
      total +
      utf8ByteLength(part.open) +
      encodedAttachmentBytes(part.source.byteLength) +
      close.length,
    utf8ByteLength(head) + tail.length,
  );
  if (length > FILE_PAGE_LIMITS.fileBytes)
    throw new EmailAttachmentFailure('tooLarge');
  const encoder = new TextEncoder();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield encoder.encode(head);
    for (const part of parts) {
      yield encoder.encode(part.open);
      yield* base64Chunks(part.source, input.signal);
      yield encoder.encode(close);
    }
    yield encoder.encode(tail);
  }
  const body = await input.spool({
    body: chunks(),
    maxBytes: length,
    signal: input.signal,
  });
  if (body.byteLength !== length) {
    await body.release();
    throw new FileInputFailure({ reason: 'file_integrity' });
  }
  return body;
}
