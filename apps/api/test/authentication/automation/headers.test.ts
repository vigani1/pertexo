import { describe, expect, it } from 'vitest';
import {
  bearerCredential,
  hasAuthorizationHeader,
} from '../../../src/authentication/automation/headers.js';

const workspaceId = '0194a800-0000-7000-8000-000000000001';
const tokenId = '0194a800-0000-7000-8000-000000000002';
const credential = `ptx_1.${workspaceId}.${tokenId}.${'A'.repeat(43)}`;
describe('Bearer header boundary', () => {
  it('accepts one standard case-insensitive scheme without exposing raw material', () => {
    const value = bearerCredential({ Authorization: `bEaReR ${credential}` });
    expect(value).toMatchObject({ workspaceId, tokenId });
    expect(JSON.stringify(value)).not.toContain(credential);
  });
  it.each([
    {},
    { authorization: '' },
    { authorization: [] },
    { authorization: ['one', 'two'] },
    {
      authorization: `Bearer ${credential}`,
      Authorization: `Bearer ${credential}`,
    },
    { authorization: `Bearer ${credential},Bearer ${credential}` },
    { authorization: `Basic ${credential}` },
    { authorization: `Bearer ${credential} ` },
  ])('refuses an ambiguous or invalid credential', (headers) => {
    expect(bearerCredential(headers)).toBeUndefined();
  });
  it('distinguishes header presence from a malformed value for cookie fallback', () => {
    expect(hasAuthorizationHeader(undefined)).toBe(false);
    expect(hasAuthorizationHeader({ authorization: [] })).toBe(true);
    expect(hasAuthorizationHeader({ Authorization: '' })).toBe(true);
  });
  it('rejects duplicates that Node discarded from normalized headers', () => {
    const headers = { authorization: `Bearer ${credential}` };
    const original = [
      'Authorization',
      `Bearer ${credential}`,
      'AUTHORIZATION',
      `Bearer ${credential}`,
    ];
    expect(hasAuthorizationHeader(undefined, original)).toBe(true);
    expect(bearerCredential(headers, original)).toBeUndefined();
    expect(bearerCredential(headers, original.slice(0, 2))).toMatchObject({
      workspaceId,
      tokenId,
    });
  });
});
