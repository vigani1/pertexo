import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  isCuratedHttpsEndpoint,
  validateCuratedTemplateSetupValue,
} from '../src/index.js';

interface CorpusCase {
  readonly name: string;
  readonly value: unknown;
  readonly accepted: boolean;
}
const corpus = JSON.parse(
  await readFile(
    new URL('./fixtures/https-endpoint-corpus.json', import.meta.url),
    'utf8',
  ),
) as readonly CorpusCase[];

describe('approved curated HTTPS endpoint grammar', () => {
  it.each(corpus)('$name', ({ value, accepted }) => {
    expect(isCuratedHttpsEndpoint(value)).toBe(accepted);
    expect(validateCuratedTemplateSetupValue('https_endpoint', value).ok).toBe(
      accepted,
    );
  });
  it('keeps corpus names unique and covers every raw ASCII position and percent byte', () => {
    expect(new Set(corpus.map(({ name }) => name)).size).toBe(corpus.length);
    for (const prefix of [
      'ascii-host-',
      'ascii-path-',
      'ascii-name-',
      'ascii-value-',
    ])
      expect(corpus.filter(({ name }) => name.startsWith(prefix))).toHaveLength(
        128,
      );
    for (const prefix of ['opaque-path-byte-', 'opaque-value-byte-'])
      expect(corpus.filter(({ name }) => name.startsWith(prefix))).toHaveLength(
        256,
      );
  });
  it('fails closed for unknown descriptor value kinds without normalization', () => {
    for (const kind of ['url', 'HTTPS_ENDPOINT', 'https_endpoint '])
      expect(
        validateCuratedTemplateSetupValue(kind, 'https://example.test/').ok,
      ).toBe(false);
    expect(isCuratedHttpsEndpoint(undefined)).toBe(false);
    expect(isCuratedHttpsEndpoint(new String('https://example.test/'))).toBe(
      false,
    );
  });
});
