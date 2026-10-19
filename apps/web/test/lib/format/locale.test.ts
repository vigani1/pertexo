import { afterEach, describe, expect, it, vi } from 'vitest';

async function localeFor(language: string) {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
  vi.resetModules();
  return (await import('@/lib/format/locale')).FORMAT_LOCALE;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('numbers in an English interface', () => {
  it('keeps Latin digits in a browser whose language writes others', async () => {
    expect((1234567).toLocaleString(await localeFor('ar-EG'))).toBe(
      '1,234,567',
    );
  });

  it('keeps the regional grouping', async () => {
    expect((1234567).toLocaleString(await localeFor('de-DE'))).toBe(
      '1.234.567',
    );
  });
});
