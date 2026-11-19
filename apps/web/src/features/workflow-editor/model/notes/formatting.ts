import type { Nodes, Root } from 'mdast';

const MAX_FORMATTING_DEPTH = 32;

// One quote or list marker opening a container inside the line's previous
// one, the way Markdown nests them on a single line.
const NESTED_OPENER =
  /^[ \t]{0,3}(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]?/u;

/**
 * Whether a line nests more quotes or lists than a note formats. Such a
 * line is shown as plain text without being parsed: parsing it costs time
 * that grows with the square of its depth, and a 4 KB line of quotes kept
 * Firefox on Linux from drawing the note for over five seconds.
 */
export function nestsTooDeeply(text: string): boolean {
  return text.split('\n').some((line) => {
    let rest = line;
    for (let depth = 1; depth <= MAX_FORMATTING_DEPTH + 1; depth++) {
      const opener = NESTED_OPENER.exec(rest)?.[0];
      if (opener === undefined || opener === '') return false;
      rest = rest.slice(opener.length);
    }
    return true;
  });
}

/**
 * Keep recursive Markdown-to-HTML conversion within a bounded stack. With
 * `tooDeep`, the text was not parsed and is shown as plain text at once.
 */
export function boundedNoteFormatting(text: string, tooDeep: boolean) {
  return () => (root: Root) => {
    if (tooDeep) {
      showAsPlainText(root, text);
      return;
    }
    const pending: { node: Nodes; depth: number }[] = [
      { node: root, depth: 0 },
    ];
    for (
      let entry = pending.pop();
      entry !== undefined;
      entry = pending.pop()
    ) {
      if (entry.depth > MAX_FORMATTING_DEPTH) {
        showAsPlainText(root, text);
        return;
      }
      if ('children' in entry.node)
        for (const node of entry.node.children)
          pending.push({ node, depth: entry.depth + 1 });
    }
  };
}

function showAsPlainText(root: Root, text: string) {
  root.children = [
    {
      type: 'paragraph',
      children: [
        {
          type: 'text',
          value:
            'This note has deeply nested formatting and is shown as plain text.',
        },
      ],
    },
    { type: 'code', value: text },
  ];
}
