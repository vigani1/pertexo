// Private byte framing shared by the two ADR066 owners. This module has no key,
// signer, verifier, database access or public package export.
const maximumFields = 110_000;
const maximumFieldBytes = 1_048_576;
const maximumFrameBytes = 16 * 1_048_576;
const fieldHeaderBytes = 5;

function invalid(): never {
  // Never include a field, frame, key or caller input in diagnostics.
  throw new Error('Native semantic attestation frame is invalid');
}

function utf8Bytes(value: string): number {
  if (value.length > maximumFieldBytes || value.includes('\0')) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumFieldBytes) invalid();
  return bytes;
}

/** Count-prefixed ordered fields: absent=0, present=1, uint32 BE UTF8 length. */
export function encodeNativeSemanticAttestationFields(
  fields: readonly (string | undefined)[],
): Buffer {
  const supplied: unknown = fields;
  if (!Array.isArray(supplied)) invalid();
  const fieldCount = fields.length;
  if (fieldCount > maximumFields) invalid();
  let frameBytes = 4;
  const lengths: number[] = [];
  const values: (string | undefined)[] = [];
  // Check all bounds and strings before allocating the encoded frame. Owners
  // supply their fixed ordered protocol fields, never a caller-selected layout.
  for (let index = 0; index < fieldCount; index += 1) {
    const field = fields[index];
    if (field !== undefined && typeof field !== 'string') invalid();
    const bytes = field === undefined ? 0 : utf8Bytes(field);
    frameBytes += fieldHeaderBytes + bytes;
    if (frameBytes > maximumFrameBytes) invalid();
    lengths.push(bytes);
    values.push(field);
  }
  const frame = Buffer.alloc(frameBytes);
  frame.writeUInt32BE(values.length, 0);
  let offset = 4;
  for (const [index, field] of values.entries()) {
    const bytes = lengths[index];
    if (bytes === undefined) invalid();
    frame.writeUInt8(field === undefined ? 0 : 1, offset);
    frame.writeUInt32BE(bytes, offset + 1);
    offset += fieldHeaderBytes;
    if (field !== undefined) {
      const written = frame.write(field, offset, bytes, 'utf8');
      if (written !== bytes) invalid();
      offset += bytes;
    }
  }
  return frame;
}
