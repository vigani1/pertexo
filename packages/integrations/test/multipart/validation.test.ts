import { describe, expect, it } from 'vitest';
import {
  httpMultipartConfigSchema,
  httpRequestConfigSchema,
  httpRequestInputSchema,
} from '../../src/index.js';
const key = 'part_11111111-1111-4111-8111-111111111111';
const part = { inputKey: key, name: 'document', kind: 'file' };
const config = {
  method: 'POST',
  url: 'https://example.test/upload',
  headers: {},
  timeoutMillis: 1000,
  maxRedirects: 0,
  maxResponseBytes: 1000,
  inlineResponseBytes: 1000,
};
describe('multipart boundary validation', () => {
  it('bounds ordered metadata and preserves duplicate names with distinct stable keys', () => {
    expect(httpMultipartConfigSchema.safeParse({ parts: [] }).success).toBe(
      false,
    );
    expect(
      httpMultipartConfigSchema.safeParse({
        parts: Array.from({ length: 65 }, () => part),
      }).success,
    ).toBe(false);
    expect(
      httpMultipartConfigSchema.safeParse({ parts: [part, part] }).success,
    ).toBe(false);
    expect(
      httpMultipartConfigSchema.safeParse({
        parts: [
          part,
          { ...part, inputKey: 'part_22222222-2222-4222-8222-222222222222' },
        ],
      }).success,
    ).toBe(true);
  });
  it.each([
    { name: '' },
    { name: 'é'.repeat(65) },
    { name: 'bad\r\nx-header: x' },
    { name: 'bad\u0085name' },
    { filename: 'bad\u009ffile' },
    { filename: '../file' },
    { filename: 'dir\\file' },
    { filename: '.' },
    { filename: '..' },
    { filename: '' },
    { filename: 'é'.repeat(128) },
    { filename: 'bad\u0000file' },
    { contentType: 'text/plain\r\nx-header: x' },
    { contentType: 'not-a-mime' },
    { inputKey: 'body' },
  ])('refuses malformed part metadata %#', (overrides) => {
    expect(
      httpMultipartConfigSchema.safeParse({
        parts: [{ ...part, ...overrides }],
      }).success,
    ).toBe(false);
  });
  it('accepts deliberate quoting and Unicode without accepting arbitrary headers', () => {
    expect(
      httpMultipartConfigSchema.safeParse({
        parts: [
          {
            ...part,
            name: 'résumé"',
            filename: '日".txt',
            contentType: 'text/plain; charset=utf-8',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      httpMultipartConfigSchema.safeParse({
        parts: [{ ...part, headers: { authorization: 'secret' } }],
      }).success,
    ).toBe(false);
  });
  it('keeps GET/HEAD and outer Content-Type conflicts out of multipart setup', () => {
    for (const method of ['GET', 'HEAD'])
      expect(
        httpRequestConfigSchema.safeParse({
          ...config,
          method,
          multipart: { parts: [part] },
        }).success,
      ).toBe(false);
    expect(
      httpRequestConfigSchema.safeParse({
        ...config,
        headers: { 'Content-Type': 'text/plain' },
        multipart: { parts: [part] },
      }).success,
    ).toBe(false);
    expect(
      httpRequestConfigSchema.safeParse({ ...config, method: 'GET' }).success,
    ).toBe(true);
  });
  it('keeps raw file limits while allowing multipart preflight to explain an oversized reference', () => {
    const reference = {
      kind: 'artifact',
      artifactId: '22222222-2222-4222-8222-222222222222',
      byteLength: 2097152,
      mediaType: 'application/octet-stream',
      sha256: 'a'.repeat(64),
    };
    expect(httpRequestInputSchema.safeParse({ body: reference }).success).toBe(
      false,
    );
    expect(httpRequestInputSchema.safeParse({ [key]: reference }).success).toBe(
      true,
    );
  });
  it('keeps raw body input compatible, admits only the reserved multipart values, and never coerces', () => {
    expect(
      httpRequestInputSchema.safeParse({
        body: { encoding: 'utf8', value: 'raw' },
      }).success,
    ).toBe(true);
    expect(
      httpRequestInputSchema.safeParse({ unexpected: 'value' }).success,
    ).toBe(false);
    expect(httpRequestInputSchema.safeParse({ [key]: 42 }).success).toBe(false);
    expect(
      httpRequestInputSchema.safeParse({
        [key]: { encoding: 'utf8', value: 'not a text value' },
      }).success,
    ).toBe(false);
    expect(httpRequestInputSchema.safeParse({ [key]: 'text' }).success).toBe(
      true,
    );
  });
});
