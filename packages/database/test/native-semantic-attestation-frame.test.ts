import { describe, expect, it } from 'vitest';
import { encodeNativeSemanticAttestationFields } from '../src/execution/workflow-calls/semantic-attestation-frame.js';

describe('private native semantic field framing', () => {
  it('encodes the checked field snapshot without a second accessor read', () => {
    let reads = 0;
    const fields = ['before'];
    Object.defineProperty(fields, 0, {
      get: () => {
        reads += 1;
        return reads === 1 ? 'before' : 'after!';
      },
    });
    expect(encodeNativeSemanticAttestationFields(fields)).toEqual(
      encodeNativeSemanticAttestationFields(['before']),
    );
    expect(reads).toBe(1);
  });
  it('encodes fixed byte tags, big-endian count/length and exact UTF8', () => {
    expect(
      encodeNativeSemanticAttestationFields([
        undefined,
        '',
        'A',
        'é',
        '😀',
      ]).toString('hex'),
    ).toBe(
      '00000005000000000001000000000100000001410100000002c3a90100000004f09f9880',
    );
  });

  it('distinguishes missing, empty, field order and delimiter-like content', () => {
    const values = [
      [],
      [undefined],
      [''],
      ['a', 'bc'],
      ['ab', 'c'],
      ['a|b', 'c'],
      ['a', 'b|c'],
      ['b', 'a'],
      ['a', 'b'],
    ];
    expect(
      new Set(
        values.map((value) =>
          encodeNativeSemanticAttestationFields(value).toString('hex'),
        ),
      ).size,
    ).toBe(values.length);
  });

  it('preserves whitespace and Unicode spelling without normalization', () => {
    for (const [left, right] of [
      ['é', 'e\u0301'],
      ['{}', ' {} '],
    ]) {
      expect(encodeNativeSemanticAttestationFields([left])).not.toEqual(
        encodeNativeSemanticAttestationFields([right]),
      );
    }
  });

  it.each(['\ud800', '\udc00', 'a\ud800b', '\0', 'value\0value'])(
    'rejects nonrepresentable PostgreSQL UTF8 text without echoing it',
    (value) => {
      expect(() => encodeNativeSemanticAttestationFields([value])).toThrow(
        'Native semantic attestation frame is invalid',
      );
    },
  );

  it('rejects runtime type confusion and excessive field count', () => {
    for (const value of [null, 0, {}, Buffer.from('secret')]) {
      expect(() =>
        encodeNativeSemanticAttestationFields([
          value,
        ] as unknown as readonly string[]),
      ).toThrow('Native semantic attestation frame is invalid');
    }
    expect(() =>
      encodeNativeSemanticAttestationFields(
        Array.from({ length: 110_001 }, () => undefined),
      ),
    ).toThrow('Native semantic attestation frame is invalid');
  });

  it('enforces UTF8 byte limits and aggregate framing overhead', () => {
    expect(
      encodeNativeSemanticAttestationFields(['a'.repeat(1_048_576)]).length,
    ).toBe(1_048_585);
    for (const value of ['a'.repeat(1_048_577), 'é'.repeat(524_289)]) {
      expect(() => encodeNativeSemanticAttestationFields([value])).toThrow();
    }
    expect(() =>
      encodeNativeSemanticAttestationFields(
        Array.from({ length: 16 }, () => 'a'.repeat(1_048_576)),
      ),
    ).toThrow();
  });
});
