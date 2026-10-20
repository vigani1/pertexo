/** Markdown links never execute a script or load an embedded resource. */
export function safeNoteUrl(value: string): string | undefined {
  try {
    const url = new URL(value, 'https://pertexo.invalid');
    return ['https:', 'http:', 'mailto:'].includes(url.protocol)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
