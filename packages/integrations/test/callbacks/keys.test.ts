import { expect, it } from 'vitest';
import {
  callbackTokenHash,
  createCallbackTokenKeys,
  parseCallbackKeyConfig,
  CALLBACK_DEVELOPMENT_KEY,
} from '../../src/callbacks/keys.js';
import { verifyCallbackTokenKeys } from '../../src/callbacks/verify.js';
const key = Buffer.alloc(32, 91).toString('base64');
const identity = { id: '01a10000-0000-7000-8000-000000000001' };
function config() {
  const parsed = parseCallbackKeyConfig(
    {
      CALLBACK_TOKEN_KEY: key,
      CALLBACK_TOKEN_KEY_VERSION: '1',
      PUBLIC_WEB_ORIGIN: 'https://example.test',
    },
    { deployed: true },
  );
  if (parsed === undefined) throw new Error('Keys missing');
  return parsed;
}
async function* probes(tokenHash: string) {
  yield await Promise.resolve({ ...identity, keyVersion: '1', tokenHash });
}
it('reproduces independent URL and authentication credentials after a restart', () => {
  const first = createCallbackTokenKeys(config());
  const material = first.material(identity, '1');
  first.close();
  const second = createCallbackTokenKeys(config());
  try {
    expect(second.material(identity, '1')).toEqual(material);
    expect(material.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(material.secret).not.toBe(material.token);
    expect(material.url).toBe(
      `https://example.test/hooks/${material.token}/resume`,
    );
    expect(
      second.material(
        { ...identity, id: '01a10000-0000-7000-8000-000000000002' },
        '1',
      ).token,
    ).not.toBe(material.token);
  } finally {
    second.close();
  }
});
it('verifies retained hashes with a previous version and refuses missing or wrong restored keys', async () => {
  const original = createCallbackTokenKeys(config());
  const hash = callbackTokenHash(original.material(identity, '1').token);
  original.close();
  const rotated = createCallbackTokenKeys({
    ...config(),
    keys: {
      current: { version: '2', key: Buffer.alloc(32, 92).toString('base64') },
      previous: [{ version: '1', key }],
    },
  });
  const wrong = createCallbackTokenKeys({
    ...config(),
    keys: {
      current: { version: '1', key: Buffer.alloc(32, 93).toString('base64') },
      previous: [],
    },
  });
  try {
    await expect(
      verifyCallbackTokenKeys(
        rotated,
        probes(hash),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyCallbackTokenKeys(
        wrong,
        probes(hash),
        new AbortController().signal,
      ),
    ).rejects.toThrow('does not match');
    await expect(
      verifyCallbackTokenKeys(
        undefined,
        probes(hash),
        new AbortController().signal,
      ),
    ).rejects.toThrow('CALLBACK_TOKEN_KEY');
  } finally {
    rotated.close();
    wrong.close();
  }
});
it('follows the invitation key pair and previous-key configuration and refuses the development key when deployed', () => {
  expect(parseCallbackKeyConfig({}, { deployed: false })).toBeUndefined();
  expect(() => {
    parseCallbackKeyConfig({}, { deployed: true });
  }).toThrow('CALLBACK_TOKEN_KEY');
  expect(() => {
    parseCallbackKeyConfig({ CALLBACK_TOKEN_KEY: key }, { deployed: false });
  }).toThrow('VERSION');
  expect(() => {
    parseCallbackKeyConfig(
      { CALLBACK_TOKEN_KEY_VERSION: '1' },
      { deployed: false },
    );
  }).toThrow('CALLBACK_TOKEN_KEY');
  expect(() => {
    parseCallbackKeyConfig(
      {
        CALLBACK_TOKEN_KEY: CALLBACK_DEVELOPMENT_KEY,
        CALLBACK_TOKEN_KEY_VERSION: '1',
        PUBLIC_WEB_ORIGIN: 'https://example.test',
      },
      { deployed: true },
    );
  }).toThrow('development');
});
