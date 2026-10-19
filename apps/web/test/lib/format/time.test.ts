import { afterEach, describe, expect, it, vi } from 'vitest';

async function formatIn(language: string) {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
  vi.resetModules();
  return import('@/lib/format/time');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('dates in an English interface', () => {
  it('writes English words in the person’s regional conventions', async () => {
    const { formatDateTime, formatRelativeTime } = await formatIn('de-DE');
    const at = '2026-10-20T15:09:00.000Z';
    const written = formatDateTime(at);
    expect(written).toContain('Oct');
    expect(written).not.toContain('Okt');
    // A German region keeps its 24-hour clock.
    expect(written).not.toMatch(/AM|PM/u);
    expect(
      formatRelativeTime('2026-10-20T15:04:00.000Z', Date.parse(at)),
    ).toMatch(/ago/u);
  });

  it('falls back to plain English for a language it can’t place', async () => {
    const { formatDate } = await formatIn('not a language');
    expect(formatDate('2026-10-20T15:09:00.000Z')).toContain('Oct');
  });
});
