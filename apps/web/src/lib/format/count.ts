import { FORMAT_LOCALE } from './locale';

// The one way to put a word in the number its count needs, from the
// locale's plural rules rather than an `=== 1` written at each place. The
// words are English; the number follows the viewer's region, as dates do.
const PLURALS = new Intl.PluralRules(FORMAT_LOCALE);

/**
 * The word for a count: `pluralWord(2, 'step')` is "steps". Give the plural
 * when adding "s" isn't it (`entry`/`entries`, `is`/`are`).
 */
export function pluralWord(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return PLURALS.select(count) === 'one' ? singular : plural;
}

/** A count with its word: "1 step", "2 steps", "12,000 entries". */
export function formatCount(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count.toLocaleString(FORMAT_LOCALE)} ${pluralWord(count, singular, plural)}`;
}
