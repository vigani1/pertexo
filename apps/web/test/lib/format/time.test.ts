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

describe('formatMoment', () => {
  it('says the day unless it is today', async () => {
    const { formatClock, formatDateTime, formatMoment } =
      await import('../../../src/lib/format/time');
    const today = new Date().toISOString();
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    expect(formatMoment(today)).toBe(formatClock(today));
    expect(formatMoment(lastWeek)).toBe(formatDateTime(lastWeek));
    expect(formatMoment(lastWeek)).not.toBe(formatClock(lastWeek));
  });
});

describe('local calendar day headings across daylight saving', () => {
  it('runs in a zone with both intended daylight-saving transitions', () => {
    expect(new Date(2026, 2, 29, 0).getTimezoneOffset()).toBe(-60);
    expect(new Date(2026, 2, 30, 0).getTimezoneOffset()).toBe(-120);
    expect(new Date(2026, 9, 25, 0).getTimezoneOffset()).toBe(-120);
    expect(new Date(2026, 9, 26, 0).getTimezoneOffset()).toBe(-60);
  });
  it.each([
    [new Date(2026, 9, 26, 12), new Date(2026, 9, 25, 0, 30), 'Yesterday'],
    [new Date(2026, 2, 30, 12), new Date(2026, 2, 28, 23, 30), 'Mar 28'],
  ])('groups %s by calendar date', async (now, event, heading) => {
    const { formatDayHeading } = await import('@/lib/format/time');
    expect(formatDayHeading(event.toISOString(), now.getTime())).toBe(heading);
  });
});
