import { Readable } from 'node:stream';
import { crc32, createInflateRaw } from 'node:zlib';
import { FileInputFailure } from '@pertexo/node-sdk/server';
import { SPREADSHEET_LIMITS } from './limits.js';
import { ZIP_FORMAT } from '../../zip-format.js';

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

const { localHeader: LOCAL, directoryEntry: ENTRY } = ZIP_FORMAT;
const { endOfDirectory: END } = ZIP_FORMAT;
const SLICE = 65_536;
// Legacy .xls and password-protected .xlsx are both OLE compound files.
const COMPOUND_FILE = Buffer.from('d0cf11e0a1b11ae1', 'hex');

export function unsupported(): never {
  throw new FileInputFailure({ reason: 'unsupported_spreadsheet' });
}
export function tooLarge(): never {
  const { uncompressedBytes, entries, sheets, cells } = SPREADSHEET_LIMITS;
  throw new FileInputFailure({
    reason: 'spreadsheet_too_large',
    limits: { uncompressedBytes, entries, sheets, cells },
  });
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
  const count = view.readUInt16LE(end + END.entries);
  const directorySize = view.readUInt32LE(end + END.directorySize);
  const directoryOffset = view.readUInt32LE(end + END.directoryOffset);
  const singleDisk =
    view.readUInt16LE(end + END.disk) === 0 &&
    view.readUInt16LE(end + END.directoryDisk) === 0 &&
    view.readUInt16LE(end + END.diskEntries) === count;
  // Zip64 marks its sizes with all-ones fields; a workbook this small never needs them.
  if (
    !singleDisk ||
    count === ZIP_FORMAT.zip64Count ||
    directoryOffset === ZIP_FORMAT.zip64Offset
  )
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
  const earliest = Math.max(
    0,
    view.length - END.bytes - ZIP_FORMAT.maxCommentBytes,
  );
  for (let offset = view.length - END.bytes; offset >= earliest; offset--)
    if (
      view.readUInt32LE(offset) === END.signature &&
      offset + END.bytes + view.readUInt16LE(offset + END.commentLength) ===
        view.length
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
      offset + ENTRY.bytes > view.length ||
      view.readUInt32LE(offset) !== ENTRY.signature
    )
      unsupported();
    const flags = view.readUInt16LE(offset + ENTRY.flags);
    const method = view.readUInt16LE(offset + ENTRY.method);
    const compressedSize = view.readUInt32LE(offset + ENTRY.compressedSize);
    const uncompressedSize = view.readUInt32LE(offset + ENTRY.size);
    const nameLength = view.readUInt16LE(offset + ENTRY.nameLength);
    const next =
      offset +
      ENTRY.bytes +
      nameLength +
      view.readUInt16LE(offset + ENTRY.extraLength) +
      view.readUInt16LE(offset + ENTRY.commentLength);
    if (next > view.length) unsupported();
    // Bit 0 marks encryption; only stored and deflated entries are standard.
    if (
      (flags & ZIP_FORMAT.encryptedFlag) !== 0 ||
      (method !== ZIP_FORMAT.methodStored &&
        method !== ZIP_FORMAT.methodDeflated)
    )
      unsupported();
    declared += uncompressedSize;
    if (declared > SPREADSHEET_LIMITS.uncompressedBytes) tooLarge();
    const name = view
      .subarray(offset + ENTRY.bytes, offset + ENTRY.bytes + nameLength)
      .toString('utf8')
      .replaceAll('\\', '/')
      .replace(/^\/+/u, '');
    if (entries.has(name)) unsupported();
    entries.set(name, {
      method,
      crc: view.readUInt32LE(offset + ENTRY.crc),
      compressedSize,
      uncompressedSize,
      dataOffset: dataOffset(
        view,
        view.readUInt32LE(offset + ENTRY.localHeaderOffset),
        compressedSize,
        start,
      ),
    });
    if (
      method === ZIP_FORMAT.methodStored &&
      compressedSize !== uncompressedSize
    )
      unsupported();
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
    header + LOCAL.bytes > directoryStart ||
    view.readUInt32LE(header) !== LOCAL.signature
  )
    unsupported();
  const start =
    header +
    LOCAL.bytes +
    view.readUInt16LE(header + LOCAL.nameLength) +
    view.readUInt16LE(header + LOCAL.extraLength);
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
    for (let offset = 0; offset < data.length; offset += SLICE) {
      const slice = data.subarray(offset, offset + SLICE);
      // A stored entry's chunks are wiped after use below; copying keeps the
      // workbook intact, as the sheet part is read twice.
      yield entry.method === ZIP_FORMAT.methodStored
        ? Buffer.from(slice)
        : slice;
    }
  }
  const source = Readable.from(slices(), { objectMode: false });
  const output =
    entry.method === ZIP_FORMAT.methodStored
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
