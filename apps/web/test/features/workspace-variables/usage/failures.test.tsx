import { screen, waitFor } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  accessLost,
  connectionLost,
  expectBar,
  FAILED_WARNING,
  held,
  onOurSide,
  openDialog,
  rateLimited,
  reference,
  REMOVE_HINT,
  removeAnyway,
  removeOff,
  serveUsage,
  settle,
  usagePage,
  USUAL_WARNING,
  workflowChanged,
} from './check.support';

const page50 = usagePage(
  { checked: 50, total: 201 },
  { next: 'c1', items: [reference('Invoice export')] },
);
const lastPage = usagePage(
  { checked: 201, total: 201 },
  { items: [reference('Weekly summary')] },
);
const tryAgain = () => screen.getByRole('button', { name: 'Try again' });

describe('a later page failing', () => {
  it('opens Remove as "Remove anyway", keeps what was found and does not ask again by itself', async () => {
    const { asked } = serveUsage({ first: [page50], c1: [onOurSide] });
    const onRemove = vi.fn();
    const event = await openDialog({ onRemove });

    expect(
      await screen.findByText('Stopped after 50 of 201 workflows you can see.'),
    ).toBeVisible();
    expectBar(50, 201);
    expect(screen.getByText('Check stopped')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoice export' })).toBeVisible();
    expect(
      screen.getByText(
        'Something went wrong on our side. Try again; if it keeps happening, quote reference abcdef12.',
      ),
    ).toBeVisible();
    expect(screen.getByText(FAILED_WARNING)).toBeVisible();
    expect(screen.queryByText(REMOVE_HINT)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Remove from draft' }),
    ).toBeNull();

    await settle();
    expect(asked).toEqual([null, 'c1']);

    expect(removeAnyway()).toBeEnabled();
    await event.click(removeAnyway());
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('closes Remove again while Try again runs, then carries on from that page', async () => {
    const retry = held(lastPage);
    const { asked } = serveUsage({
      first: [page50],
      c1: [onOurSide, retry.reply],
    });
    const event = await openDialog({ onRemove: vi.fn() });
    await screen.findByText('Stopped after 50 of 201 workflows you can see.');

    await event.click(tryAgain());
    // Still holding the old error here: only the running retry says it's undecided.
    await waitFor(() => {
      expect(removeOff()).toBeDisabled();
    });
    expect(screen.queryByRole('button', { name: 'Remove anyway' })).toBeNull();
    expect(
      screen.getByText('Checked 50 of 201 workflows you can see.'),
    ).toBeVisible();
    expect(screen.queryByText(FAILED_WARNING)).toBeNull();
    expect(screen.getByText(REMOVE_HINT)).toBeVisible();

    retry.release();
    expect(
      await screen.findByText('Checked all 201 workflows you can see.'),
    ).toBeVisible();
    expect(removeOff()).toBeEnabled();
    expect(screen.getByText(USUAL_WARNING)).toBeVisible();
    expect(asked).toEqual([null, 'c1', 'c1']);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('goes back to "Remove anyway" when Try again fails too, and still does not ask by itself', async () => {
    const { asked } = serveUsage({
      first: [page50],
      c1: [onOurSide, onOurSide],
    });
    const event = await openDialog({ onRemove: vi.fn() });
    await screen.findByText('Stopped after 50 of 201 workflows you can see.');
    await event.click(tryAgain());
    await waitFor(() => {
      expect(asked).toEqual([null, 'c1', 'c1']);
    });
    expect(await screen.findByText(FAILED_WARNING)).toBeVisible();
    expect(removeAnyway()).toBeEnabled();
    await settle();
    expect(asked).toEqual([null, 'c1', 'c1']);
  });

  it('says the connection was lost when the network drops', async () => {
    serveUsage({ first: [page50], c1: [connectionLost] });
    await openDialog({ onRemove: vi.fn() });
    expect(
      await screen.findByText(
        'Pertexo couldn’t be reached. Check your connection and try again.',
      ),
    ).toBeVisible();
    expect(removeAnyway()).toBeEnabled();
  });
});

describe('a rate limit', () => {
  it('shows the wait partway, and Try again resumes from where it stopped', async () => {
    const { asked } = serveUsage({
      first: [page50],
      c1: [rateLimited, lastPage],
    });
    const event = await openDialog({ onRemove: vi.fn() });

    expect(
      await screen.findByText('Too many requests. Try again in 7 s.'),
    ).toBeVisible();
    expect(removeAnyway()).toBeEnabled();

    await event.click(tryAgain());
    expect(
      await screen.findByText('Checked all 201 workflows you can see.'),
    ).toBeVisible();
    // Not from the start: page one was never asked for twice.
    expect(asked).toEqual([null, 'c1', 'c1']);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(removeOff()).toBeEnabled();
  });

  it('shows the wait on the first page too', async () => {
    serveUsage({ first: [rateLimited] });
    await openDialog({ onRemove: vi.fn() });
    expect(
      await screen.findByText('Too many requests. Try again in 7 s.'),
    ).toBeVisible();
    expect(removeAnyway()).toBeEnabled();
  });
});

describe('a workflow changing during the check', () => {
  it('asks for a restart, which starts from the first page and closes Remove again', async () => {
    const restarted = held(
      usagePage(
        { checked: 201, total: 201 },
        { items: [reference('Fresh result')] },
      ),
    );
    const { asked } = serveUsage({
      first: [page50, restarted.reply],
      c1: [workflowChanged],
    });
    const event = await openDialog({ onRemove: vi.fn() });

    expect(
      await screen.findByText(
        'A workflow changed while it was being checked. Restart the check for current results.',
      ),
    ).toBeVisible();
    expect(removeAnyway()).toBeEnabled();
    expect(screen.getByText(FAILED_WARNING)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    await event.click(screen.getByRole('button', { name: 'Restart check' }));
    expect(await screen.findByText('Checking workflows…')).toBeVisible();
    expectBar(0, 1);
    expect(removeOff()).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Invoice export' })).toBeNull();

    restarted.release();
    expect(
      await screen.findByText('Checked all 201 workflows you can see.'),
    ).toBeVisible();
    expect(asked).toEqual([null, 'c1', null]);
    expect(screen.getByRole('link', { name: 'Fresh result' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Invoice export' })).toBeNull();
    expect(removeOff()).toBeEnabled();
  });
});

describe('the first page failing', () => {
  it('explains itself, offers Retry and "Remove anyway", and does not ask again by itself', async () => {
    const retry = held(lastPage);
    const { asked } = serveUsage({ first: [onOurSide, retry.reply] });
    const event = await openDialog({ onRemove: vi.fn() });

    expect(
      await screen.findByText(
        'Workflow references couldn’t be loaded. Try again.',
      ),
    ).toBeVisible();
    expect(removeAnyway()).toBeEnabled();
    expect(screen.getByText(FAILED_WARNING)).toBeVisible();
    // Nothing was checked, so there is no count to stand behind.
    expect(screen.queryByRole('progressbar')).toBeNull();
    await settle();
    expect(asked).toEqual([null]);

    await event.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Checking workflows…')).toBeVisible();
    expect(removeOff()).toBeDisabled();

    retry.release();
    expect(
      await screen.findByText('Checked all 201 workflows you can see.'),
    ).toBeVisible();
    expect(removeOff()).toBeEnabled();
    expect(asked).toEqual([null, null]);
  });

  it('treats a page it cannot read as a failed check, never as "unused"', async () => {
    serveUsage({
      first: [
        () =>
          HttpResponse.json({ items: [], nextCursor: null, incomplete: false }),
      ],
    });
    await openDialog({ onRemove: vi.fn() });
    expect(
      await screen.findByText(
        'Workflow references couldn’t be loaded. Try again.',
      ),
    ).toBeVisible();
    expect(removeAnyway()).toBeEnabled();
    expect(
      screen.queryByText(
        'No current draft or publication references this name.',
      ),
    ).toBeNull();
  });
});

describe('Try again meeting a different answer', () => {
  it('asks for a restart when a workflow changed in the meantime', async () => {
    const { asked } = serveUsage({
      first: [page50],
      c1: [rateLimited, workflowChanged],
    });
    const event = await openDialog({ onRemove: vi.fn() });
    await screen.findByText('Too many requests. Try again in 7 s.');

    await event.click(tryAgain());
    expect(
      await screen.findByRole('button', { name: 'Restart check' }),
    ).toBeVisible();
    expect(removeAnyway()).toBeEnabled();
    expect(asked).toEqual([null, 'c1', 'c1']);
  });
});

describe('losing access during the check', () => {
  it('hides what was found and offers no way to carry on', async () => {
    const { asked } = serveUsage({ first: [page50], c1: [accessLost] });
    await openDialog({ onRemove: vi.fn() });

    expect(
      await screen.findByText(
        'Your role no longer has access to workflow references here.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Invoice export' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await settle();
    expect(asked).toEqual([null, 'c1']);
  });

  it('leaves a running Retry alone until it has answered', async () => {
    const retry = held(page50);
    const { asked, signals } = serveUsage({
      first: [page50, retry.reply],
      c1: [accessLost],
    });
    const event = await openDialog({ onRemove: vi.fn() });
    await screen.findByText(
      'Your role no longer has access to workflow references here.',
    );

    await event.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(asked).toEqual([null, 'c1', null]);
    expect(signals[2]?.aborted).toBe(false);
    expect(removeOff()).toBeDisabled();
    retry.release();
  });

  // Bug variables-dialog-02: a Retry that answers changes nothing the walk's effect watches, so the walk stops for good.
  it.fails(
    'walks on from the first page when Retry finds access back',
    async () => {
      const retry = held(page50);
      const { asked } = serveUsage({
        first: [page50, retry.reply],
        c1: [accessLost, lastPage],
      });
      const event = await openDialog({ onRemove: vi.fn() });
      await screen.findByText(
        'Your role no longer has access to workflow references here.',
      );

      await event.click(screen.getByRole('button', { name: 'Retry' }));
      await settle();
      retry.release();
      expect(
        await screen.findByText('Checked all 201 workflows you can see.'),
      ).toBeVisible();
      expect(asked).toEqual([null, 'c1', null, 'c1']);
      expect(removeOff()).toBeEnabled();
    },
  );

  it('stays refused, with Retry on offer, when Retry is refused too', async () => {
    serveUsage({
      first: [page50, accessLost],
      c1: [accessLost, accessLost],
    });
    const event = await openDialog({ onRemove: vi.fn() });
    const refused =
      'Your role no longer has access to workflow references here.';
    await screen.findByText(refused);

    await event.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    });
    await settle();
    expect(screen.getByText(refused)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Invoice export' })).toBeNull();
    expect(removeAnyway()).toBeEnabled();
  });

  // Bug variables-dialog-01: a refused Retry clears the "next page failed" state, so the walk asks the refused page once more by itself.
  it.fails(
    'does not ask a refused page again by itself after a refused Retry',
    async () => {
      const { asked } = serveUsage({
        first: [page50, accessLost],
        c1: [accessLost, accessLost],
      });
      const event = await openDialog({ onRemove: vi.fn() });
      await screen.findByText(
        'Your role no longer has access to workflow references here.',
      );

      await event.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(asked.length).toBeGreaterThanOrEqual(3);
      });
      await settle();
      expect(asked).toEqual([null, 'c1', null]);
    },
  );
});
