import { notifyManager } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  barWidth,
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
    const second = held(
      usagePage({ checked: 100, total: 201 }, { next: 'c2' }),
    );
    const { asked, pageSizes } = serveUsage({
      first: [
        usagePage(
          { checked: 50, total: 201 },
          { next: 'c1', items: [reference('Invoice export')] },
        ),
      ],
      c1: [second.reply],
      c2: [
        usagePage(
          { checked: 201, total: 201 },
          { items: [reference('Weekly summary')] },
        ),
      ],
    });
    const onRemove = vi.fn();
    const event = await openDialog({ onRemove });

    expect(
      await screen.findByText('Checked 50 of 201 workflows you can see.'),
    ).toBeVisible();
    expectBar(50, 201);
    expect(Number.parseFloat(barWidth())).toBeCloseTo(24.88, 1);
    expect(screen.getByText('Checking workflows')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoice export' })).toBeVisible();
    // Between two pages there is nothing to click, and a name can't go yet.
    expect(removeOff()).toBeDisabled();
    expect(screen.getByText(REMOVE_HINT)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Check more|Try again/u }),
    ).toBeNull();

    second.release();
    expect(
      await screen.findByText('Checked all 201 workflows you can see.'),
    ).toBeVisible();
    expectBar(201, 201);
    expect(barWidth()).toBe('100%');
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
    const first = held(usagePage({ checked: 1, total: 1 }));
    serveUsage({ first: [first.reply] });
    await openDialog({ onRemove: vi.fn() });

    expect(await screen.findByText('Checking workflows…')).toBeVisible();
    expectBar(0, 1);
    expect(removeOff()).toBeDisabled();
    expect(screen.getByText(REMOVE_HINT)).toBeVisible();

    first.release();
    expect(
      await screen.findByText('Checked the 1 workflow you can see.'),
    ).toBeVisible();
    expect(removeOff()).toBeEnabled();
  });

  it('never calls a name unused before the last page', async () => {
    const last = held(usagePage({ checked: 2, total: 2 }));
    serveUsage({
      first: [usagePage({ checked: 1, total: 2 }, { next: 'c1' })],
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
    expect(
      screen.getByText('Checked all 2 workflows you can see.'),
    ).toBeVisible();
  });

  it('counts one workflow in the singular while it is in progress', async () => {
    const last = held(usagePage({ checked: 1, total: 1 }));
    serveUsage({
      first: [usagePage({ checked: 0, total: 1 }, { next: 'c1' })],
      c1: [last.reply],
    });
    await openDialog();
    expect(
      await screen.findByText('Checked 0 of 1 workflow you can see.'),
    ).toBeVisible();
    last.release();
    expect(
      await screen.findByText('Checked the 1 workflow you can see.'),
    ).toBeVisible();
  });

  it('shows a full, valid bar when no workflows are visible', async () => {
    serveUsage({ first: [usagePage({ checked: 0, total: 0 })] });
    await openDialog({ onRemove: vi.fn() });

    expect(
      await screen.findByText('You can’t see any workflows to check.'),
    ).toBeVisible();
    expectBar(1, 1);
    expect(barWidth()).toBe('100%');
    expect(removeOff()).toBeEnabled();
    expect(
      screen.getByText('No current draft or publication references this name.'),
    ).toBeVisible();
  });

  it('says the check is incomplete if any page could not be analysed, not only the last', async () => {
    serveUsage({
      first: [
        usagePage({ checked: 1, total: 2 }, { next: 'c1', incomplete: true }),
      ],
      c1: [usagePage({ checked: 2, total: 2 })],
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
      first: [usagePage({ checked: 1, total: 2 }, { next: 'c1' })],
      c1: [
        usagePage(
          { checked: 2, total: 2 },
          { items: [reference('Invoice export')] },
        ),
      ],
    });
    await openDialog();

    expect(
      await screen.findByText('Checked all 2 workflows you can see.'),
    ).toBeVisible();
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

  // Bug variables-dialog-02: a page that answers before "fetching" is rendered changes nothing the walk's effect watches, so the walk stops for good.
  it.fails('still walks to the end', async () => {
    serveUsage({
      first: [usagePage({ checked: 1, total: 3 }, { next: 'c1' })],
      c1: [usagePage({ checked: 2, total: 3 }, { next: 'c2' })],
      c2: [usagePage({ checked: 3, total: 3 })],
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
      expect(
        await screen.findByText('Checked all 3 workflows you can see.'),
      ).toBeVisible();
    } finally {
      clearInterval(pump);
    }
  });
});

describe('closing the dialog', () => {
  it('calls off the page in flight, asks for no more, and starts over when opened again', async () => {
    const second = held(usagePage({ checked: 2, total: 3 }, { next: 'c2' }));
    const { asked, signals } = serveUsage({
      first: [
        usagePage({ checked: 1, total: 3 }, { next: 'c1' }),
        usagePage({ checked: 3, total: 3 }),
      ],
      c1: [second.reply],
    });
    const { event, open } = await renderOpener();
    await open();
    await screen.findByText('Checked 1 of 3 workflows you can see.');
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
    expect(
      await screen.findByText('Checked all 3 workflows you can see.'),
    ).toBeVisible();
    expect(asked).toEqual([null, 'c1', null]);
  });
});
