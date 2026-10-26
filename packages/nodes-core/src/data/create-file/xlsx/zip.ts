import { Readable } from 'node:stream';
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';

export type ZipPart = Readonly<{
  name: string;
  content: Uint8Array | AsyncIterable<Uint8Array>;
}>;
type Written = Readonly<{
  name: Buffer;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}>;

// A streamed entry's sizes and CRC follow its data in a descriptor.
const DESCRIPTOR_FLAG = 0x08;
// 1980-01-01 00:00 in DOS form, so the same rows give the same bytes.
const DOS_DATE = 0x21;

/** Writes a zip whose last part may be streamed; sizes stay far below Zip64. */
export async function* writeZip(
  parts: readonly ZipPart[],
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const written: Written[] = [];
  let offset = 0;
  for (const part of parts) {
    signal.throwIfAborted();
    const name = Buffer.from(part.name, 'utf8');
    if (part.content instanceof Uint8Array) {
      const data = deflateRawSync(part.content);
      const entry = {
        name,
        flags: 0,
        crc: crc32(part.content),
        compressedSize: data.length,
        size: part.content.length,
        offset,
      };
      const header = localHeader(entry);
      yield header;
      yield data;
      written.push(entry);
      offset += header.length + data.length;
      continue;
    }
    const header = localHeader({
      name,
      flags: DESCRIPTOR_FLAG,
      crc: 0,
      compressedSize: 0,
      size: 0,
      offset,
    });
    yield header;
    const tally = { crc: 0, size: 0, compressedSize: 0 };
    for await (const chunk of deflated(part.content, tally)) {
      tally.compressedSize += chunk.length;
      yield chunk;
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(tally.crc, 4);
    descriptor.writeUInt32LE(tally.compressedSize, 8);
    descriptor.writeUInt32LE(tally.size, 12);
    yield descriptor;
    written.push({ name, flags: DESCRIPTOR_FLAG, ...tally, offset });
    offset += header.length + tally.compressedSize + descriptor.length;
  }
  const directory = Buffer.concat(written.flatMap(directoryEntry));
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(written.length, 8);
  end.writeUInt16LE(written.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield directory;
  yield end;
}

async function* deflated(
  content: AsyncIterable<Uint8Array>,
  tally: { crc: number; size: number },
): AsyncGenerator<Buffer> {
  async function* counted() {
    for await (const chunk of content) {
      tally.crc = crc32(chunk, tally.crc);
      tally.size += chunk.length;
      yield chunk;
    }
  }
  const source = Readable.from(counted(), { objectMode: false });
  const deflate = createDeflateRaw();
  // pipe() doesn't forward a failing source; the row writer's refusals must surface.
  source.on('error', (error) => deflate.destroy(error));
  source.pipe(deflate);
  try {
    for await (const chunk of deflate as AsyncIterable<Buffer>) yield chunk;
  } finally {
    source.destroy();
    deflate.destroy();
  }
}

function localHeader(entry: Written): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  return Buffer.concat([header, entry.name]);
}

function directoryEntry(entry: Written): Buffer[] {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(entry.offset, 42);
  return [header, entry.name];
}
