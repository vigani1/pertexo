import { Readable } from 'node:stream';
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';
import { ZIP_FORMAT } from '../../zip-format.js';

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

const { localHeader: LOCAL, descriptor: DESCRIPTOR } = ZIP_FORMAT;
const { directoryEntry: ENTRY, endOfDirectory: END } = ZIP_FORMAT;
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
      flags: ZIP_FORMAT.descriptorFlag,
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
    const descriptor = Buffer.alloc(DESCRIPTOR.bytes);
    descriptor.writeUInt32LE(DESCRIPTOR.signature, 0);
    descriptor.writeUInt32LE(tally.crc, DESCRIPTOR.crc);
    descriptor.writeUInt32LE(tally.compressedSize, DESCRIPTOR.compressedSize);
    descriptor.writeUInt32LE(tally.size, DESCRIPTOR.size);
    yield descriptor;
    written.push({ name, flags: ZIP_FORMAT.descriptorFlag, ...tally, offset });
    offset += header.length + tally.compressedSize + descriptor.length;
  }
  const directory = Buffer.concat(written.flatMap(directoryEntry));
  const end = Buffer.alloc(END.bytes);
  end.writeUInt32LE(END.signature, 0);
  end.writeUInt16LE(written.length, END.diskEntries);
  end.writeUInt16LE(written.length, END.entries);
  end.writeUInt32LE(directory.length, END.directorySize);
  end.writeUInt32LE(offset, END.directoryOffset);
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
  const header = Buffer.alloc(LOCAL.bytes);
  header.writeUInt32LE(LOCAL.signature, 0);
  header.writeUInt16LE(ZIP_FORMAT.versionNeeded, LOCAL.version);
  header.writeUInt16LE(entry.flags, LOCAL.flags);
  header.writeUInt16LE(ZIP_FORMAT.methodDeflated, LOCAL.method);
  header.writeUInt16LE(DOS_DATE, LOCAL.date);
  header.writeUInt32LE(entry.crc, LOCAL.crc);
  header.writeUInt32LE(entry.compressedSize, LOCAL.compressedSize);
  header.writeUInt32LE(entry.size, LOCAL.size);
  header.writeUInt16LE(entry.name.length, LOCAL.nameLength);
  return Buffer.concat([header, entry.name]);
}

function directoryEntry(entry: Written): Buffer[] {
  const header = Buffer.alloc(ENTRY.bytes);
  header.writeUInt32LE(ENTRY.signature, 0);
  header.writeUInt16LE(ZIP_FORMAT.versionNeeded, ENTRY.versionMadeBy);
  header.writeUInt16LE(ZIP_FORMAT.versionNeeded, ENTRY.versionNeeded);
  header.writeUInt16LE(entry.flags, ENTRY.flags);
  header.writeUInt16LE(ZIP_FORMAT.methodDeflated, ENTRY.method);
  header.writeUInt16LE(DOS_DATE, ENTRY.date);
  header.writeUInt32LE(entry.crc, ENTRY.crc);
  header.writeUInt32LE(entry.compressedSize, ENTRY.compressedSize);
  header.writeUInt32LE(entry.size, ENTRY.size);
  header.writeUInt16LE(entry.name.length, ENTRY.nameLength);
  header.writeUInt32LE(entry.offset, ENTRY.localHeaderOffset);
  return [header, entry.name];
}
