import { Readable } from 'node:stream';
import { crc32, createInflateRaw } from 'node:zlib';
import { FileInputFailure } from '@pertexo/node-sdk/server';
import { SPREADSHEET_LIMITS } from './limits.js';

type ArchiveEntry = Readonly<{
  method: 0 | 8;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
}>;
export type WorkbookArchive = Readonly<{
  has(name: string): boolean;
  names(): Iterable<string>;
  /** Inflates one entry in bounded chunks, checking its length and CRC. */
  read(name: string, signal: AbortSignal): AsyncGenerator<Uint8Array>;
}>;

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const SLICE = 65_536;
// Legacy .xls and password-protected .xlsx are both OLE compound files.
const COMPOUND_FILE = Buffer.from('d0cf11e0a1b11ae1', 'hex');

export function unsupported(): never {
  throw new FileInputFailure({ reason: 'unsupported_spreadsheet' });
}
export function tooLarge(): never {
  throw new FileInputFailure({ reason: 'spreadsheet_too_large' });
}

/** Reads the zip directory only; nothing is inflated until an entry is read. */
export function openWorkbookArchive(bytes: Uint8Array): WorkbookArchive {
  try {
    return openArchive(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
  } catch (error) {
    if (error instanceof FileInputFailure) throw error;
    // Out-of-range reads mean the directory points outside the file.
    return unsupported();
  }
}

function openArchive(view: Buffer): WorkbookArchive {
  if (view.subarray(0, COMPOUND_FILE.length).equals(COMPOUND_FILE))
    unsupported();
  const end = findEndOfDirectory(view);
  const count = view.readUInt16LE(end + 10);
  const directorySize = view.readUInt32LE(end + 12);
  const directoryOffset = view.readUInt32LE(end + 16);
  const singleDisk =
    view.readUInt16LE(end + 4) === 0 &&
    view.readUInt16LE(end + 6) === 0 &&
    view.readUInt16LE(end + 8) === count;
  // Zip64 marks its sizes with all-ones fields; a workbook this small never needs them.
  if (!singleDisk || count === 0xffff || directoryOffset === 0xffffffff)
    unsupported();
  if (count > SPREADSHEET_LIMITS.entries) tooLarge();
  if (directoryOffset + directorySize > end) unsupported();
  const entries = readDirectory(view, directoryOffset, count);
  return Object.freeze({
    has: (name: string) => entries.has(name),
    names: () => entries.keys(),
    read: (name: string, signal: AbortSignal) => {
      const entry = entries.get(name);
      if (entry === undefined) return unsupported();
      return inflate(view, entry, signal);
    },
  });
}

function findEndOfDirectory(view: Buffer): number {
  const earliest = Math.max(0, view.length - 22 - 0xffff);
  for (let offset = view.length - 22; offset >= earliest; offset--)
    if (
      view.readUInt32LE(offset) === END_OF_DIRECTORY &&
      offset + 22 + view.readUInt16LE(offset + 20) === view.length
    )
      return offset;
  return unsupported();
}

function readDirectory(
  view: Buffer,
  start: number,
  count: number,
): ReadonlyMap<string, ArchiveEntry> {
  const entries = new Map<string, ArchiveEntry>();
  let offset = start,
    declared = 0;
  for (let index = 0; index < count; index++) {
    if (
      offset + 46 > view.length ||
      view.readUInt32LE(offset) !== DIRECTORY_ENTRY
    )
      unsupported();
    const flags = view.readUInt16LE(offset + 8);
    const method = view.readUInt16LE(offset + 10);
    const compressedSize = view.readUInt32LE(offset + 20);
    const uncompressedSize = view.readUInt32LE(offset + 24);
    const nameLength = view.readUInt16LE(offset + 28);
    const next =
      offset +
      46 +
      nameLength +
      view.readUInt16LE(offset + 30) +
      view.readUInt16LE(offset + 32);
    if (next > view.length) unsupported();
    // Bit 0 marks encryption; only stored and deflated entries are standard.
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) unsupported();
    declared += uncompressedSize;
    if (declared > SPREADSHEET_LIMITS.uncompressedBytes) tooLarge();
    const name = view
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8')
      .replaceAll('\\', '/')
      .replace(/^\/+/u, '');
    if (entries.has(name)) unsupported();
    entries.set(name, {
      method,
      crc: view.readUInt32LE(offset + 16),
      compressedSize,
      uncompressedSize,
      dataOffset: dataOffset(
        view,
        view.readUInt32LE(offset + 42),
        compressedSize,
        start,
      ),
    });
    if (method === 0 && compressedSize !== uncompressedSize) unsupported();
    offset = next;
  }
  return entries;
}

function dataOffset(
  view: Buffer,
  header: number,
  compressedSize: number,
  directoryStart: number,
): number {
  if (
    header + 30 > directoryStart ||
    view.readUInt32LE(header) !== LOCAL_HEADER
  )
    unsupported();
  const start =
    header +
    30 +
    view.readUInt16LE(header + 26) +
    view.readUInt16LE(header + 28);
  if (start + compressedSize > directoryStart) unsupported();
  return start;
}

async function* inflate(
  view: Buffer,
  entry: ArchiveEntry,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const data = view.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  let produced = 0,
    checksum = 0;
  function* slices() {
    for (let offset = 0; offset < data.length; offset += SLICE)
      yield data.subarray(offset, offset + SLICE);
  }
  const source = Readable.from(slices(), { objectMode: false });
  const output =
    entry.method === 0
      ? source
      : source.pipe(createInflateRaw({ chunkSize: SLICE }));
  try {
    for await (const value of output as AsyncIterable<Buffer>) {
      signal.throwIfAborted();
      produced += value.byteLength;
      // A directory that understates an entry is how a zip bomb hides.
      if (produced > entry.uncompressedSize) tooLarge();
      checksum = crc32(value, checksum);
      try {
        yield value;
      } finally {
        value.fill(0);
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof FileInputFailure) throw error;
    unsupported();
  } finally {
    source.destroy();
    output.destroy();
  }
  if (produced !== entry.uncompressedSize || checksum !== entry.crc)
    unsupported();
}
