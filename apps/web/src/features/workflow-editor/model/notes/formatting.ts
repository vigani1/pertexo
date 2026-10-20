import type { Nodes, Root } from 'mdast';

const MAX_FORMATTING_DEPTH = 32;

/** Keep recursive Markdown-to-HTML conversion within a bounded stack. */
export function boundedNoteFormatting(text: string) {
  return () => (root: Root) => {
    const pending: { node: Nodes; depth: number }[] = [
      { node: root, depth: 0 },
    ];
    for (
      let entry = pending.pop();
      entry !== undefined;
      entry = pending.pop()
    ) {
      if (entry.depth > MAX_FORMATTING_DEPTH) {
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
        return;
      }
      if ('children' in entry.node)
        for (const node of entry.node.children)
          pending.push({ node, depth: entry.depth + 1 });
    }
  };
}
