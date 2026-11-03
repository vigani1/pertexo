import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApplicationSecretEnvelope } from '@pertexo/secrets/server';
import {
  sealNoticeUnsubscribe,
  openNoticeUnsubscribe,
} from '../../src/inbox/notice-unsubscribe.js';
const envelope = createApplicationSecretEnvelope({
  current: { version: 'v1', key: Buffer.alloc(32, 1).toString('base64') },
});
const claims = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  revision: 3,
  memberRevision: 7,
  expiresAt: '2026-10-16T00:00:00.000Z',
};
const now = new Date('2026-10-15T00:00:00Z');
describe('scoped unsubscribe capability', () => {
  it('seals one person/workspace/revision/incarnation without exposing them', () => {
    const token = sealNoticeUnsubscribe(envelope, claims);
    expect(token).not.toContain(claims.actorId);
    expect(openNoticeUnsubscribe(envelope, token, now)).toEqual(claims);
  });
  it('refuses expiry, wrong keys, tampering, oversized and wrong-purpose envelopes', () => {
    const token = sealNoticeUnsubscribe(envelope, claims);
    expect(
      openNoticeUnsubscribe(envelope, token, new Date(claims.expiresAt)),
    ).toBeNull();
    const other = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 2).toString('base64') },
    });
    expect(openNoticeUnsubscribe(other, token, now)).toBeNull();
    expect(
      openNoticeUnsubscribe(envelope, `${token.slice(0, -5)}aaaaa`, now),
    ).toBeNull();
    expect(openNoticeUnsubscribe(envelope, 'x'.repeat(4097), now)).toBeNull();
    const different = Buffer.from(
      JSON.stringify(
        envelope.seal(JSON.stringify(claims), 'pertexo/another-purpose'),
      ),
    ).toString('base64url');
    expect(openNoticeUnsubscribe(envelope, different, now)).toBeNull();
  });
  it('accepts a retained key and refuses one that has been retired', () => {
    const token = sealNoticeUnsubscribe(envelope, claims);
    const v2 = { version: 'v2', key: Buffer.alloc(32, 3).toString('base64') };
    const rotated = createApplicationSecretEnvelope({
      current: v2,
      previous: [
        { version: 'v1', key: Buffer.alloc(32, 1).toString('base64') },
      ],
    });
    expect(openNoticeUnsubscribe(rotated, token, now)).toEqual(claims);
    expect(
      openNoticeUnsubscribe(
        createApplicationSecretEnvelope({ current: v2 }),
        token,
        now,
      ),
    ).toBeNull();
  });
  it.each([
    ['tag', 4],
    ['tag', 12],
    ['tag', 17],
    ['nonce', 8],
    ['nonce', 13],
  ] as const)(
    'refuses public unsubscribe tokens carrying a %s of %s bytes',
    (field, bytes) => {
      const token = sealNoticeUnsubscribe(envelope, claims);
      const sealed = JSON.parse(
        Buffer.from(token, 'base64url').toString('utf8'),
      ) as Record<string, string>;
      const original = Buffer.from(sealed[field] ?? '', 'base64url');
      sealed[field] = Buffer.concat([original, Buffer.alloc(bytes)])
        .subarray(0, bytes)
        .toString('base64url');
      const damaged = Buffer.from(JSON.stringify(sealed)).toString('base64url');
      expect(openNoticeUnsubscribe(envelope, damaged, now)).toBeNull();
      expect(openNoticeUnsubscribe(envelope, token, now)).toEqual(claims);
    },
  );
  it.each([8, 11, 13, 16])(
    'refuses an authenticated public capability with a %s-byte nonce',
    (bytes) => {
      const nonce = Buffer.alloc(bytes, 7);
      const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 1), nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(Buffer.from('pertexo/notice-unsubscribe'));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(claims)),
        cipher.final(),
      ]);
      const token = Buffer.from(
        JSON.stringify({
          keyVersion: 'v1',
          nonce: nonce.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
          ciphertext: ciphertext.toString('base64url'),
        }),
      ).toString('base64url');
      expect(openNoticeUnsubscribe(envelope, token, now)).toBeNull();
    },
  );
});
