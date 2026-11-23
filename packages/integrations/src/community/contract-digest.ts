import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE32_BITS = 5;
const BITS_PER_BYTE = 8;

/** SHA-256 with unpadded lowercase Base32, sized for the existing identities. */
export function communityContractDigest(
  domain: 'definition' | 'executor' | 'credential',
  contract: unknown,
): string {
  const digest = createHash('sha256')
    .update(canonicalJson(['pertexo.community.v1', domain, contract]))
    .digest();
  let encoded = '';
  let pending = 0;
  let bits = 0;
  const mask = BASE32.length - 1;
  for (const byte of digest) {
    pending = (pending << BITS_PER_BYTE) | byte;
    bits += BITS_PER_BYTE;
    while (bits >= BASE32_BITS) {
      bits -= BASE32_BITS;
      encoded += BASE32.charAt((pending >>> bits) & mask);
    }
  }
  if (bits > 0)
    encoded += BASE32.charAt((pending << (BASE32_BITS - bits)) & mask);
  return encoded;
}
