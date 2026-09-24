import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoadMore } from '../../src/components/patterns/load-more';
import { SkeletonRows } from '../../src/components/ui/skeleton';

describe('list states', () => {
  it('loads the next page and retries it after a failure', async () => {
    const load = vi.fn();
    const { rerender } = render(
      <LoadMore
        subject="members"
        hasNextPage
        loading={false}
        failed={false}
        onLoadMore={load}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(load).toHaveBeenCalledOnce();

    rerender(
      <LoadMore
        subject="members"
        hasNextPage
        loading
        failed={false}
        onLoadMore={load}
      />,
    );
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();

    rerender(
      <LoadMore
        subject="members"
        hasNextPage
        loading={false}
        failed
        onLoadMore={load}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'More members couldn’t be loaded. The ones above are unchanged.',
    );
    expect(
      screen.getByRole('button', { name: 'Retry next page' }),
    ).toBeEnabled();
  });

  it('renders nothing on the last page', () => {
    const { container } = render(
      <LoadMore
        subject="runs"
        hasNextPage={false}
        loading={false}
        failed={false}
        onLoadMore={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('announces a loading list once, in the shape of its rows', () => {
    const { container } = render(
      <SkeletonRows label="Loading members" rows={2} mark="avatar" />,
    );
    expect(
      screen.getByRole('status', { name: 'Loading members' }),
    ).toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-slot="skeleton-thread"]'),
    ).toHaveLength(2);
  });
});
