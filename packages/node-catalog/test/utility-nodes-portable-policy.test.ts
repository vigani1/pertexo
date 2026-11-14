import { expect, it } from 'vitest';
import { platformPortableDefinitionPolicy } from '../src/server.js';

it('admits portable utility settings and requires an encrypted signing connection without accepting a key in config', () => {
  const policy = platformPortableDefinitionPolicy();
  const hmac = policy.definitions.find((d) => d.key === 'core.hmac');
  expect(hmac?.slots).toEqual([
    {
      slot: 'hmac_key',
      providerKey: 'signing',
      authType: 'hmac_key',
      optional: false,
    },
  ]);
  expect(hmac?.validateConfig({ algorithm: 'sha256', encoding: 'hex' })).toBe(
    true,
  );
  expect(
    hmac?.validateConfig({
      algorithm: 'sha256',
      encoding: 'hex',
      key: 'private',
    }),
  ).toBe(false);
  expect(hmac?.validateConfig({ algorithm: 'md5', encoding: 'hex' })).toBe(
    false,
  );
  for (const [key, config] of [
    ['core.text', { operation: 'replace', all: true }],
    ['core.xml', { operation: 'parse' }],
    [
      'core.html',
      {
        operation: 'attribute',
        selector: 'a.invoice',
        attribute: 'href',
        limit: 100,
      },
    ],
    ['core.crypto', { operation: 'random_id', length: 24 }],
    [
      'core.number',
      {
        operation: 'currency',
        locale: 'de-DE',
        currency: 'EUR',
        grouping: true,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      },
    ],
  ] as const)
    expect(
      policy.definitions.find((d) => d.key === key)?.validateConfig(config),
    ).toBe(true);
  expect(
    policy.definitions
      .find((d) => d.key === 'core.html')
      ?.validateConfig({ operation: 'text', selector: 'a', limit: 4_999 }),
  ).toBe(false);
  expect(
    policy.definitions
      .find((d) => d.key === 'core.number')
      ?.validateConfig({
        operation: 'decimal',
        locale: 'en-US',
        grouping: true,
        minimumFractionDigits: 3,
        maximumFractionDigits: 2,
      }),
  ).toBe(false);
});
