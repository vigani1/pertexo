import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  QueryView,
  type ReadQuery,
} from '../../src/components/patterns/states/query-view';
import { ApiError } from '../../src/lib/api/error';

type Notes = readonly string[];

function read(overrides: Partial<ReadQuery<Notes>>): ReadQuery<Notes> {
  return {
    data: undefined,
    isPending: false,
    isError: false,
    isFetching: false,
    error: null,
    dataUpdatedAt: Date.parse('2026-10-24T09:30:00Z'),
    refetch: vi.fn(),
    ...overrides,
  };
}

function NotesView({ query }: Readonly<{ query: ReadQuery<Notes> }>) {
  return (
    <QueryView
      query={query}
      resource="Notes"
      isEmpty={(notes) => notes.length === 0}
      empty={<p>No notes yet.</p>}
    >
      {(notes) => (
        <label>
          Draft reply
          <input defaultValue={notes.join(', ')} />
        </label>
      )}
    </QueryView>
  );
}

describe('QueryView', () => {
  it('announces the first read while it loads', () => {
    render(<NotesView query={read({ isPending: true, isFetching: true })} />);
    expect(screen.getByRole('status', { name: 'Loading notes' })).toBeVisible();
  });

  it('offers Retry when the first read fails', async () => {
    const refetch = vi.fn();
    render(
      <NotesView
        query={read({
          isError: true,
          error: new ApiError({ kind: 'network', message: 'offline' }),
          refetch,
        })}
      />,
    );
    expect(
      screen.getByText(
        'Notes couldn’t be reached. Check your connection and try again.',
      ),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('keeps the content and its unsaved edits when a refresh fails', async () => {
    const loaded = read({ data: ['first'] });
    const { rerender } = render(<NotesView query={loaded} />);
    const draft = screen.getByRole('textbox', { name: 'Draft reply' });
    await userEvent.setup().type(draft, ' and more');

    rerender(
      <NotesView
        query={{
          ...loaded,
          isError: true,
          error: new ApiError({ kind: 'timeout', message: 'slow' }),
        }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Couldn’t refresh\. Showing results from/u,
    );
    expect(screen.getByRole('textbox', { name: 'Draft reply' })).toBe(draft);
    expect(draft).toHaveValue('first and more');
  });

  it('hides data loaded earlier once access is gone', () => {
    render(
      <NotesView
        query={read({
          data: ['private'],
          isError: true,
          error: new ApiError({
            kind: 'problem',
            status: 403,
            message: 'No access',
          }),
        })}
      />,
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      screen.getByText('Your role no longer has access to notes here.'),
    ).toBeVisible();
  });

  it('says so when the read has nothing in it', () => {
    render(<NotesView query={read({ data: [] })} />);
    expect(screen.getByText('No notes yet.')).toBeVisible();
  });
});
