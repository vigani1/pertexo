/**
 * The zip layout (APPNOTE 6.3): record signatures, sizes and field offsets.
 * The workbook writer and the workbook reader both use this one table, so
 * what one writes the other reads.
 */
export const ZIP_FORMAT = Object.freeze({
  versionNeeded: 20,
  methodStored: 0,
  methodDeflated: 8,
  encryptedFlag: 0x01,
  // A streamed entry's sizes and CRC follow its data in a descriptor.
  descriptorFlag: 0x08,
  // Zip64 marks its counts and offsets with all-ones fields.
  zip64Count: 0xffff,
  zip64Offset: 0xffffffff,
  maxCommentBytes: 0xffff,
  localHeader: Object.freeze({
    signature: 0x04034b50,
    bytes: 30,
    version: 4,
    flags: 6,
    method: 8,
    date: 12,
    crc: 14,
    compressedSize: 18,
    size: 22,
    nameLength: 26,
    extraLength: 28,
  }),
  descriptor: Object.freeze({
    signature: 0x08074b50,
    bytes: 16,
    crc: 4,
    compressedSize: 8,
    size: 12,
  }),
  directoryEntry: Object.freeze({
    signature: 0x02014b50,
    bytes: 46,
    versionMadeBy: 4,
    versionNeeded: 6,
    flags: 8,
    method: 10,
    date: 14,
    crc: 16,
    compressedSize: 20,
    size: 24,
    nameLength: 28,
    extraLength: 30,
    commentLength: 32,
    localHeaderOffset: 42,
  }),
  endOfDirectory: Object.freeze({
    signature: 0x06054b50,
    bytes: 22,
    disk: 4,
    directoryDisk: 6,
    diskEntries: 8,
    entries: 10,
    directorySize: 12,
    directoryOffset: 16,
    commentLength: 20,
  }),
});
