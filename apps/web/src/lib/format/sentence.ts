/** Capitalizes a phrase that starts a sentence. */
export function sentenceStart(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
