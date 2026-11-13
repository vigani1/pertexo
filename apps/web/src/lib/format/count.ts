/**
 * A count with its noun in the right number: "1 step", "2 steps", "0
 * cases". Give the plural when adding "s" isn't it ("1 entry", "2 entries").
 */
export function formatCount(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`;
}
