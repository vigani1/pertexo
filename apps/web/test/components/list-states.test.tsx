import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoadMore } from '../../src/components/patterns/lists/load-more';
import { ApiError } from '../../src/lib/api/error';
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

  it('names why the next page failed and keeps the loaded rows reassurance', () => {
    render(
      <LoadMore
        subject="versions"
        hasNextPage
        loading={false}
        failed
        error={new ApiError({ kind: 'network', message: 'offline' })}
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'More versions couldn’t be reached. Check your connection and try again. The ones above are unchanged.',
    );
    expect(
      screen.getByRole('button', { name: 'Retry next page' }),
    ).toBeEnabled();
  });

  it('keeps the loaded rows reassurance through a rate-limit wait', () => {
    vi.useFakeTimers();
    try {
      render(
        <LoadMore
          subject="versions"
          hasNextPage
          loading={false}
          failed
          error={
            new ApiError({
              kind: 'problem',
              status: 429,
              message: 'Too many requests',
              retryAfterMs: 2_000,
            })
          }
          onLoadMore={vi.fn()}
        />,
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Too many requests. Try again in 2 s. The ones above are unchanged.',
      );

      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Too many requests. You can try again now. The ones above are unchanged.',
      );
      expect(
        screen.getByRole('button', { name: 'Retry next page' }),
      ).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the loaded rows reassurance when the session ended', () => {
    render(
      <LoadMore
        subject="runs"
        hasNextPage
        loading={false}
        failed
        error={
          new ApiError({
            kind: 'problem',
            status: 401,
            message: 'Authentication required',
            problem: {
              type: 'urn:pertexo:problem:auth.unauthenticated',
              title: 'Authentication required',
              status: 401,
              code: 'auth.unauthenticated',
              requestId: 'request-signed-out',
            },
          })
        }
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your session ended. Sign in again. The ones above are unchanged.',
    );
    expect(
      screen.getByRole('link', { name: /^Sign in again/ }),
    ).toBeInTheDocument();
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

  it('announces a loading list', () => {
    render(<SkeletonRows label="Loading members" rows={2} mark="avatar" />);
    expect(
      screen.getByRole('status', { name: 'Loading members' }),
    ).toBeInTheDocument();
  });
});
