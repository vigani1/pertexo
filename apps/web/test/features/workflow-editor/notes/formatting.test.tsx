import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NoteMarkdown } from '@/features/workflow-editor/components/canvas/notes/markdown';

describe('bounded note formatting', () => {
  it('renders ordinary supported formatting without a plain-text fallback', () => {
    render(
      <NoteMarkdown
        text={
          '# Orders\n\nKeep **one** per order.\n\n> Verified\n\n- Capture\n- Validate'
        }
      />,
    );
    expect(screen.getByRole('heading', { name: 'Orders' })).toBeVisible();
    expect(screen.getByText('one').tagName).toBe('STRONG');
    expect(screen.getByText('Verified').closest('blockquote')).not.toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/shown as plain text/u)).toBeNull();
  });
  it.each([
    ['block quotes', '>'.repeat(3998) + 'x'],
    ['nested lists', '  - '.repeat(999) + 'x'],
  ])(
    'retains all source text and keeps rendering usable for deeply nested %s',
    (_kind, text) => {
      const { container } = render(<NoteMarkdown text={text} />);
      expect(
        screen.getByText(
          'This note has deeply nested formatting and is shown as plain text.',
        ),
      ).toBeVisible();
      expect(container.querySelector('pre code')?.textContent).toBe(
        `${text}\n`,
      );
      expect(screen.queryByRole('heading')).toBeNull();
    },
  );
});
