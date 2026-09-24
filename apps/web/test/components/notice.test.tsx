import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StaleLine } from '../../src/components/patterns/stale-line';
import { Button } from '../../src/components/ui/button';
import { Notice } from '../../src/components/ui/notice';

describe('Notice', () => {
  it('announces destructive notices as alerts and the rest politely', () => {
    render(
      <>
        <Notice tone="destructive">Saving didn’t work.</Notice>
        <Notice tone="warning">You’re offline.</Notice>
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Saving didn’t work.');
    expect(screen.getByRole('status')).toHaveTextContent('You’re offline.');
  });

  it('keeps a caller role, a specific thread and one follow-up action', () => {
    const { container } = render(
      <Notice
        tone="warning"
        role="alert"
        glyph="waiting"
        title="Check your inbox"
        action={<Button type="button">Resend</Button>}
      >
        The link expires soon.
      </Notice>,
    );
    const notice = screen.getByRole('alert');
    expect(notice).toHaveAttribute('data-tone', 'warning');
    expect(notice).toHaveTextContent('Check your inbox');
    expect(screen.getByRole('button', { name: 'Resend' })).toBeVisible();
    expect(
      container.querySelector('[data-slot="status-glyph"]'),
    ).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('StaleLine', () => {
  it('says how old the data is and retries on request', async () => {
    const retry = vi.fn();
    const { rerender } = render(
      <StaleLine
        updatedAt={Date.UTC(2026, 8, 24, 12)}
        retrying={false}
        onRetry={retry}
      >
        Your edits are kept.
      </StaleLine>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      /^Couldn’t refresh\. Showing results from .+\. Your edits are kept\.Retry$/u,
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();

    rerender(
      <StaleLine
        updatedAt={Date.UTC(2026, 8, 24, 12)}
        retrying
        onRetry={retry}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
  });
});
