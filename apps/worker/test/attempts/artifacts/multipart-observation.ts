import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { Busboy } from '@fastify/busboy';

/** The owned destination uses an independent parser, never the production encoder. */
export async function observeMultipart(body: Buffer, contentType: string) {
  const match = /^multipart\/form-data; boundary=([A-Za-z0-9-]+)$/u.exec(
    contentType,
  );
  const boundary = match?.[1];
  if (
    boundary === undefined ||
    !body
      .subarray(-Buffer.byteLength(`--${boundary}--\r\n`))
      .equals(Buffer.from(`--${boundary}--\r\n`))
  )
    throw new Error('Invalid multipart closing boundary');
  const headers = body
    .toString('latin1')
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => part.slice(2, part.indexOf('\r\n\r\n')).split('\r\n'));
  const parts: {
    name: string;
    filename: string | null;
    contentType: string | null;
    byteLength: number;
    sha256: string;
  }[] = [];
  const parser = new Busboy({
    headers: { 'content-type': contentType },
    isPartAFile: () => true,
    limits: { parts: 64, files: 64, fileSize: 10485760, headerSize: 4096 },
  });
  parser.on('file', (name, stream, filename) => {
    const index = parts.length;
    const type = headers[index]
      ?.find((header) => header.toLowerCase().startsWith('content-type: '))
      ?.slice('Content-Type: '.length);
    const part = {
      name,
      filename: filename || null,
      contentType: type ?? null,
      byteLength: 0,
      sha256: '',
    };
    parts.push(part);
    const hash = createHash('sha256');
    stream.on('data', (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) {
        parser.destroy(new Error('Non-byte multipart data'));
        return;
      }
      part.byteLength += chunk.byteLength;
      hash.update(chunk);
    });
    stream.on('end', () => {
      part.sha256 = hash.digest('hex');
    });
    stream.on('error', (error: Error) => {
      parser.destroy(error);
    });
    stream.on('limit', () => {
      parser.destroy(new Error('Multipart part too large'));
    });
  });
  parser.on('partsLimit', () => {
    parser.destroy(new Error('Too many multipart parts'));
  });
  parser.on('filesLimit', () => {
    parser.destroy(new Error('Too many multipart files'));
  });
  const completion = finished(parser, { cleanup: true });
  parser.end(body);
  await completion;
  if (
    headers.length !== parts.length ||
    parts.some(({ sha256 }) => sha256 === '')
  )
    throw new Error('Multipart parts differ from wire framing');
  return {
    wireBytes: body.byteLength,
    wireSha256: createHash('sha256').update(body).digest('hex'),
    parts,
  };
}
