// The one way to put a word in the number its count needs, from the
// locale's plural rules rather than an `=== 1` written at each place.
const PLURALS = new Intl.PluralRules('en-US');

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
  return `${count.toLocaleString('en-US')} ${pluralWord(count, singular, plural)}`;
}
