const UTF16_PAIRED_CODE_UNITS = 2;
const STARTS_WITH_WORD_CHARACTER = /^[\p{L}\p{N}\p{M}\p{Pc}]/u;
const ENDS_WITH_WORD_CHARACTER = /[\p{L}\p{N}\p{M}\p{Pc}]$/u;

export function normalizeGuardrailsText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('ς', 'σ')
    .replaceAll('ß', 'ss');
}

export function countLiteral(
  text: string,
  literal: string,
  wholeWord: boolean,
): number {
  let count = 0;
  let start = text.indexOf(literal);
  while (start !== -1) {
    const end = start + literal.length;
    const match = !wholeWord || boundedByWords(text, start, end);
    if (match) count += 1;
    start = text.indexOf(literal, match ? end : start + 1);
  }
  return count;
}

function boundedByWords(text: string, start: number, end: number): boolean {
  // A neighboring Unicode character may span two UTF-16 code units.
  return (
    !ENDS_WITH_WORD_CHARACTER.test(
      text.slice(Math.max(0, start - UTF16_PAIRED_CODE_UNITS), start),
    ) &&
    !STARTS_WITH_WORD_CHARACTER.test(
      text.slice(end, end + UTF16_PAIRED_CODE_UNITS),
    )
  );
}

export function countProhibitedTerms(
  text: string,
  terms: readonly string[],
): number {
  const normalized = new Set(terms.map(normalizeGuardrailsText));
  let count = 0;
  for (const term of normalized) {
    count += countLiteral(text, term, true);
  }
  return count;
}
