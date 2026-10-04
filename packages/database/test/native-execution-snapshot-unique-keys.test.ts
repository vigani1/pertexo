import { describe, expect, it } from 'vitest';
import { parseWorkflowExecutionValueSnapshot } from '../src/execution/node-attempts/node-attempt-call-input-record.js';

describe('native execution snapshot original-byte recovery', () => {
  it('rejects nested duplicate original keys even when bytes and normalized projection agree', () => {
    expect(() =>
      parseWorkflowExecutionValueSnapshot({
        reference: {
          schemaVersion: 1,
          kind: 'inline',
          value: { nested: { key: 2 } },
        },
        serializedValue: '{"nested":{"key":1,"key":2}}',
        sha256:
          '76bbb41e039af42266c17e4a19f3505cd2a96d5b12a55e43943ff85087800623',
        byteLength: 28,
      }),
    ).toThrow('duplicate object keys');
  });

  it('treats an escaped spelling of the same key as a duplicate', () => {
    expect(() =>
      parseWorkflowExecutionValueSnapshot({
        reference: {
          schemaVersion: 1,
          kind: 'inline',
          value: { nested: { key: 2 } },
        },
        serializedValue: '{"nested":{"key":1,"\\u006bey":2}}',
        sha256:
          '2bb9bcd28a4d8c49e21fa6224d1a1f894e0f30a401099a9792556bec49429e79',
        byteLength: 33,
      }),
    ).toThrow('duplicate object keys');
  });

  it.each([
    {
      value: [{ same: 1 }, { same: 2 }],
      serializedValue: '[{"same":1},{"same":2}]',
      sha256:
        '2d2295ea00dd20809dbacb9afea79515adb8b0ec5fc063a8f2be1b541c7f3dc7',
      byteLength: 23,
    },
    {
      value: { text: '{"same":1,"same":2}', same: 3 },
      serializedValue: '{"text":"{\\"same\\":1,\\"same\\":2}","same":3}',
      sha256:
        '11ee85dd33ec63cb2b9574a2fc8109e8f88cda5f6854b66f7e8d708a69599d2e',
      byteLength: 43,
    },
  ])(
    'retains legal original $serializedValue without false duplicate matches',
    (input) => {
      const { value, ...identity } = input;
      const snapshot = {
        reference: { schemaVersion: 1, kind: 'inline', value },
        ...identity,
      };
      expect(parseWorkflowExecutionValueSnapshot(snapshot)).toEqual(snapshot);
    },
  );
});
