import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NoteForm } from '@/features/workflow-editor/components/canvas/notes/form';

const note = {
  id: '00000000-0000-4000-8000-000000000003',
  text: '',
  position: { x: 0, y: 0 },
  size: { width: 320, height: 200 },
  color: 'neutral' as const,
};

// product-ux-28: the dialog says what is happening, in one spelling.
describe('the note dialog', () => {
  it('adds a new note', () => {
    render(
      <NoteForm mode="add" note={note} onClose={vi.fn()} onApply={vi.fn()} />,
    );
    expect(screen.getByRole('dialog', { name: 'Add a note' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Color' })).toBeVisible();
  });

  it('edits an existing note', () => {
    render(
      <NoteForm
        mode="edit"
        note={{ ...note, text: 'Why this exists' }}
        onClose={vi.fn()}
        onApply={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Edit note' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save note' })).toBeVisible();
  });
});
