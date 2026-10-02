import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  isCuratedHttpsEndpointV1,
  validateCuratedTemplateSetupValue,
} from '../src/curated-templates.js';

interface CorpusCase {
  readonly name: string;
  readonly value: unknown;
  readonly accepted: boolean;
}
const corpus = JSON.parse(
  await readFile(
    new URL(
      './fixtures/curated-https-endpoint-v1-corpus.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as readonly CorpusCase[];

describe('approved curated HTTPS endpoint v1 grammar', () => {
  it.each(corpus)('$name', ({ value, accepted }) => {
    expect(isCuratedHttpsEndpointV1(value)).toBe(accepted);
    expect(
      validateCuratedTemplateSetupValue('curated_https_endpoint_v1', value).ok,
    ).toBe(accepted);
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
  it('fails closed for obsolete or unknown descriptor value kinds without normalization', () => {
    expect(
      validateCuratedTemplateSetupValue(
        'https_endpoint',
        'https://example.test/',
      ).ok,
    ).toBe(false);
    expect(
      validateCuratedTemplateSetupValue(
        'curated_https_endpoint_v2',
        'https://example.test/',
      ).ok,
    ).toBe(false);
    expect(isCuratedHttpsEndpointV1(undefined)).toBe(false);
    expect(isCuratedHttpsEndpointV1(new String('https://example.test/'))).toBe(
      false,
    );
  });
});
