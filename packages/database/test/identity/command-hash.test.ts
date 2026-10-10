import { describe, expect, it } from 'vitest';

import {
  commandKeySchema,
  commandRevisionSchema,
  hashFlatIdentityCommand,
  hashIdentityCommandKey,
} from '../../src/tenant-access/command-keys.js';

describe('flat identity command receipt hashes', () => {
  it('retains the shared printable-key and positive-revision boundaries', () => {
    expect(commandKeySchema.parse('a,b')).toBe('a,b');
    expect(commandKeySchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(commandKeySchema.safeParse('a b').success).toBe(false);
    expect(commandRevisionSchema.parse(1)).toBe(1);
    expect(commandRevisionSchema.safeParse(0).success).toBe(false);
  });
  it('retains member, profile and rename bytes regardless of insertion order', () => {
    const rename = {
      workspaceId: 'w',
      name: 'A',
      expectedRevision: 2,
      actorUserId: 'u',
    };
    expect(hashFlatIdentityCommand(rename)).toBe(
      'e25259cc270b419fc2044b640363f05ab09cf57a0a552d2be815665e227e3717',
    );
    expect(
      hashFlatIdentityCommand({
        actorUserId: 'u',
        expectedRevision: 2,
        name: 'A',
        workspaceId: 'w',
      }),
    ).toBe(hashFlatIdentityCommand(rename));
    expect(
      hashFlatIdentityCommand({
        actorUserId: 'u',
        displayName: 'A',
        expectedRevision: 2,
      }),
    ).toBe('e08324a210ac0aa443e40280cf8f256490559da3294ad22f8c549bcb67fe1d38');
    expect(
      hashFlatIdentityCommand({
        expectedRoleRevision: 2,
        role: 'builder',
        workspaceId: 'w',
        actorUserId: 'u',
        targetUserId: 't',
      }),
    ).toBe('0e26b1986c2df63cee1f31767f4f3c1e5388ff3fa68c0cc3690e02e29d8cc35d');
    expect(hashIdentityCommandKey('key')).toBe(
      '2c70e12b7a0646f92279f427c7b38e7334d8e5389cff167a1dc30e73f826b683',
    );
  });

  it('rejects nested values instead of hashing distinct bodies identically', () => {
    expect(() =>
      hashFlatIdentityCommand({ profile: { name: 'A' } } as never),
    ).toThrow(TypeError);
    expect(() =>
      hashFlatIdentityCommand({ profile: { name: 'B' } } as never),
    ).toThrow(TypeError);
    expect(() =>
      hashFlatIdentityCommand({ value: undefined } as never),
    ).toThrow(TypeError);
  });
});
