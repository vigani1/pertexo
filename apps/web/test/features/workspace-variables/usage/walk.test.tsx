import { notifyManager } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expectBar,
  held,
  openDialog,
  reference,
  REMOVE_HINT,
  removeOff,
  renderOpener,
  serveUsage,
  settle,
  usagePage,
  USUAL_WARNING,
} from './check.support';

describe('a check running by itself', () => {
  it('walks every page with no click, showing its progress, and only then lets a name go', async () => {
    const second = held(usagePage({ next: 'c2' }));
    const { asked, pageSizes } = serveUsage({
      first: [usagePage({ next: 'c1', items: [reference('Invoice export')] })],
      c1: [second.reply],
      c2: [usagePage({ items: [reference('Weekly summary')] })],
    });
    const onRemove = vi.fn();
    const event = await openDialog({ onRemove });

    expect(await screen.findByText(/Checking workflows…/u)).toBeVisible();
    expectBar();

    expect(screen.getByText('Checking workflows')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoice export' })).toBeVisible();
    // Between two pages there is nothing to click, and a name can't go yet.
    expect(removeOff()).toBeDisabled();
    expect(screen.getByText(REMOVE_HINT)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Check more|Try again/u }),
    ).toBeNull();

    second.release();
    expect(await screen.findByText(/Check complete\./u)).toBeVisible();
    expectBar();

    expect(screen.getByText('Check finished')).toBeInTheDocument();
    expect(asked).toEqual([null, 'c1', 'c2']);
    // Dense references cost fewer requests against the rate limit this way.
    expect(pageSizes).toEqual(['100', '100', '100']);
    expect(screen.getByRole('link', { name: 'Weekly summary' })).toBeVisible();
    expect(removeOff()).toBeEnabled();
    expect(screen.queryByText(REMOVE_HINT)).toBeNull();
    expect(screen.getByText(USUAL_WARNING)).toBeVisible();

    await event.click(removeOff());
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('keeps Remove off, with an empty bar, while the first page is on its way', async () => {
    const first = held(usagePage());
    serveUsage({ first: [first.reply] });
    await openDialog({ onRemove: vi.fn() });

    expect(await screen.findByText(/Checking workflows…/u)).toBeVisible();
    expectBar();
    expect(removeOff()).toBeDisabled();
    expect(screen.getByText(REMOVE_HINT)).toBeVisible();

    first.release();
    expect(await screen.findByText(/Check complete\./u)).toBeVisible();
    expect(removeOff()).toBeEnabled();
  });

  it('never calls a name unused before the last page', async () => {
    const last = held(usagePage());
    serveUsage({
      first: [usagePage({ next: 'c1' })],
      c1: [last.reply],
    });
    await openDialog();

    expect(
      await screen.findByText('No references in the workflows checked so far.'),
    ).toBeVisible();
    expect(
      screen.queryByText(
        'No current draft or publication references this name.',
      ),
    ).toBeNull();

    last.release();
    expect(
      await screen.findByText(
        'No current draft or publication references this name.',
      ),
    ).toBeVisible();
    expect(screen.getByText(/Check complete\./u)).toBeVisible();
  });

  it('keeps checking through a cursor with no references yet', async () => {
    const last = held(usagePage());
    serveUsage({
      first: [usagePage({ next: 'c1' })],
      c1: [last.reply],
    });
    await openDialog();
    expect(await screen.findByText(/Checking workflows…/u)).toBeVisible();
    last.release();
    expect(await screen.findByText(/Check complete\./u)).toBeVisible();
  });

  it('finishes honestly with no references when no workflows are visible', async () => {
    serveUsage({ first: [usagePage()] });
    await openDialog({ onRemove: vi.fn() });

    expect(
      await screen.findByText('Check complete. 0 references found.'),
    ).toBeVisible();
    expectBar();

    expect(removeOff()).toBeEnabled();
    expect(
      screen.getByText('No current draft or publication references this name.'),
    ).toBeVisible();
  });

  it('says the check is incomplete if any page could not be analysed, not only the last', async () => {
    serveUsage({
      first: [usagePage({ next: 'c1', incomplete: true })],
      c1: [usagePage()],
    });
    await openDialog();

    expect(
      await screen.findByText(
        'No parsed reference found; the check is incomplete.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Some draft expressions are invalid and could not be analysed. Fix them before relying on this check.',
      ),
    ).toBeVisible();
  });

  it('walks to the end for a member who cannot remove names, and offers nothing to remove', async () => {
    const { asked } = serveUsage({
      first: [usagePage({ next: 'c1' })],
      c1: [usagePage({ items: [reference('Invoice export')] })],
    });
    await openDialog();

    expect(await screen.findByText(/Check complete\./u)).toBeVisible();
    expect(asked).toEqual([null, 'c1']);
    expect(screen.getByRole('link', { name: 'Invoice export' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Remove/u })).toBeNull();
    expect(screen.queryByText(REMOVE_HINT)).toBeNull();
    expect(screen.queryByText(USUAL_WARNING)).toBeNull();
  });
});

describe('a tab whose timers run late, as a hidden one’s do', () => {
  afterEach(() => {
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  });

  it('still walks to the end', async () => {
    serveUsage({
      first: [usagePage({ next: 'c1' })],
      c1: [usagePage({ next: 'c2' })],
      c2: [usagePage()],
    });
    const { open, queryClient } = await renderOpener();
    // The library tells React through setTimeout. Holding that back until each
    // page has answered is what a throttled timer does, without the timing.
    const late: (() => void)[] = [];
    notifyManager.setScheduler((callback) => {
      late.push(callback);
    });
    const pump = setInterval(() => {
      if (queryClient.isFetching() === 0)
        for (const callback of late.splice(0)) callback();
    }, 10);
    try {
      await open();
      expect(await screen.findByText(/Check complete\./u)).toBeVisible();
    } finally {
      clearInterval(pump);
    }
  });
});

describe('closing the dialog', () => {
  it('calls off the page in flight, asks for no more, and starts over when opened again', async () => {
    const second = held(usagePage({ next: 'c2' }));
    const { asked, signals } = serveUsage({
      first: [usagePage({ next: 'c1' }), usagePage()],
      c1: [second.reply],
    });
    const { event, open } = await renderOpener();
    await open();
    await screen.findByText(/Checking workflows…/u);
    await waitFor(() => {
      expect(asked).toEqual([null, 'c1']);
    });

    await event.click(screen.getByRole('button', { name: 'Close references' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(signals[1]?.aborted).toBe(true);
    });
    second.release();
    await settle();
    expect(asked).toEqual([null, 'c1']);

    await open();
    expect(await screen.findByText(/Check complete\./u)).toBeVisible();
    expect(asked).toEqual([null, 'c1', null]);
  });
});

it('shows references while a cursor remains and reports completion without an exact percentage', async () => {
  const pending = held(usagePage({ items: [reference('Second')] }));
  serveUsage({
    first: [usagePage({ next: 'later', items: [reference('First')] })],
    later: [pending.reply],
  });
  await openDialog();
  try {
    expect(await screen.findByRole('link', { name: 'First' })).toBeVisible();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute(
      'aria-valuenow',
    );
    expect(
      await screen.findByText('Checking workflows… 1 reference found so far.'),
    ).toBeVisible();
    pending.release();
    expect(
      await screen.findByText('Check complete. 2 references found.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Second' })).toBeVisible();
  } finally {
    pending.release();
  }
});
