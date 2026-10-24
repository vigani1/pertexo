import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

/** Readable excerpts use the same Markdown grammar as notes, without markup or link targets. */
export function noteTextStart(source: string): string {
  const pending: Nodes[] = [fromMarkdown(source)];
  const words: string[] = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (
      node.type === 'text' ||
      node.type === 'inlineCode' ||
      node.type === 'code'
    )
      words.push(node.value);
    else if ('children' in node) {
      // Block boundaries become spaces; inline emphasis and links join their own text.
      const unsupportedTextContainer =
        node.type !== 'root' &&
        node.type !== 'emphasis' &&
        node.type !== 'strong' &&
        node.type !== 'link' &&
        node.type !== 'linkReference';
      if (unsupportedTextContainer) words.push(' ');
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i];
        if (child !== undefined) pending.push(child);
      }
    } else if (node.type === 'break') words.push(' ');
  }
  return words.join('').replace(/\s+/gu, ' ').trim().slice(0, 80);
}
