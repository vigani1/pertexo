import { describe, expect, it } from 'vitest';
import {
  issueApiTokenCredential,
  matchesApiTokenDigest,
  parseApiTokenCredential,
} from '../../../src/tenant-access/tokens/credential.js';

const workspaceId = '0194a800-0000-7000-8000-000000000001';
const tokenId = '0194a800-0000-7000-8000-000000000002';
describe('opaque API token credentials', () => {
  it('uses fresh secret material and authenticates the complete credential', () => {
    const first = issueApiTokenCredential(workspaceId, tokenId);
    const second = issueApiTokenCredential(workspaceId, tokenId);
    const parsed = parseApiTokenCredential(first.secret);
    expect(parsed).toEqual({ workspaceId, tokenId, digest: first.digest });
    expect(first.secret).not.toBe(second.secret);
    expect(first.secret.split('.')[3]).toHaveLength(43);
    expect(matchesApiTokenDigest(first.digest, first.digest)).toBe(true);
    expect(matchesApiTokenDigest(first.digest, second.digest)).toBe(false);
    const changedWorkspace = parseApiTokenCredential(
      first.secret.replace(workspaceId, tokenId),
    );
    expect(changedWorkspace?.digest).not.toBe(first.digest);
    expect(JSON.stringify(parsed)).not.toContain(first.secret);
  });
  it.each([
    undefined,
    '',
    'Bearer x',
    'ptx_2.x',
    'x'.repeat(10000),
    'ptx_1.invalid.invalid.' + 'A'.repeat(43),
  ])('refuses malformed input without disclosing it', (value) => {
    expect(parseApiTokenCredential(value)).toBeUndefined();
  });
  it('refuses noncanonical base64url and uppercase public identifiers', () => {
    const credential = issueApiTokenCredential(workspaceId, tokenId).secret;
    expect(
      parseApiTokenCredential(credential.slice(0, -1) + 'B'),
    ).toBeUndefined();
    expect(
      parseApiTokenCredential(credential.replace('a800', 'A800')),
    ).toBeUndefined();
  });
});
