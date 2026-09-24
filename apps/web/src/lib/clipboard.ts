/**
 * Writes text to the clipboard. Resolves false instead of throwing when the
 * browser has no clipboard here (an insecure origin) or blocks the write.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
