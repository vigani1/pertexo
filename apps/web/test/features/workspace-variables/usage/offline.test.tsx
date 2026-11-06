import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  expectBar,
  FAILED_WARNING,
  goOffline,
  goOnline,
  held,
  onOurSide,
  openDialog,
  reference,
  REMOVE_HINT,
  removeAnyway,
  removeOff,
  renderOpener,
  serveUsage,
  settle,
  usagePage,
  workflowChanged,
} from './check.support';

const page50 = usagePage({ next: 'c1' });
const lastPage = usagePage();

describe('opening the dialog offline', () => {
  it('keeps Remove off with nothing checked, then runs by itself on reconnect', async () => {
    const { asked } = serveUsage({ first: [page50], c1: [lastPage] });
    const { open } = await renderOpener({ onRemove: vi.fn() });
    goOffline();
    await open();

    expect(await screen.findByText(/Checking workflows…/u)).toBeVisible();
    expect(removeOff()).toBeDisabled();
    expect(screen.getByText(REMOVE_HINT)).toBeVisible();
    expectBar();

    await settle();
    expect(asked).toEqual([]);

    goOnline();
    expect(await screen.findByText(/Check complete\./u)).toBeVisible();
    expect(asked).toEqual([null, 'c1']);
    expect(removeOff()).toBeEnabled();
  });
});

describe('closing the dialog while it waits for the network', () => {
  it('asks for nothing on reconnect', async () => {
    const { asked } = serveUsage({});
    const { event, open } = await renderOpener({ onRemove: vi.fn() });
    goOffline();
    await open();
    await screen.findByText(/Checking workflows…/u);

    await event.click(screen.getByRole('button', { name: 'Close references' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    goOnline();
    await settle();
    expect(asked).toEqual([]);
  });
});

describe('going offline partway', () => {
  it('keeps the results and keeps Remove off, then carries on by itself', async () => {
    const first = held(page50);
    const { asked } = serveUsage({ first: [first.reply], c1: [lastPage] });
    await openDialog({ onRemove: vi.fn() });
    await screen.findByText(/Checking workflows…/u);
    await waitFor(() => {
      expect(asked).toEqual([null]);
    });

    goOffline();
    first.release();
    expect(await screen.findByText(/Checking workflows…/u)).toBeVisible();
    expectBar();
    expect(removeOff()).toBeDisabled();
    expect(screen.getByText(REMOVE_HINT)).toBeVisible();
    await settle();
    expect(asked).toEqual([null]);

    goOnline();
    expect(await screen.findByText(/Check complete\./u)).toBeVisible();
    expect(removeOff()).toBeEnabled();
    expect(asked).toEqual([null, 'c1']);
  });
});

describe('a retry made offline', () => {
  it('of a failed first read goes back to checking, with Remove off', async () => {
    const { asked } = serveUsage({ first: [onOurSide, lastPage] });
    const event = await openDialog({ onRemove: vi.fn() });
    await screen.findByText(
      'Workflow references couldn’t be loaded. Try again.',
    );
    expect(removeAnyway()).toBeEnabled();

    goOffline();
    await event.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Checking workflows…/u)).toBeVisible();
    expect(removeOff()).toBeDisabled();
    await settle();
    expect(asked).toEqual([null]);

    goOnline();
    expect(await screen.findByText(/Check complete\./u)).toBeVisible();
    expect(removeOff()).toBeEnabled();
  });

  it('of a failed later page stays "Remove anyway", then carries on by itself', async () => {
    const { asked } = serveUsage({
      first: [page50],
      c1: [onOurSide, lastPage],
    });
    const event = await openDialog({ onRemove: vi.fn() });
    await screen.findByText(/Check stopped\./u);

    goOffline();
    await event.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(removeAnyway()).toBeEnabled();
    expect(screen.getByText(FAILED_WARNING)).toBeVisible();
    expect(screen.getByText(/Check stopped\./u)).toBeVisible();
    expect(asked).toEqual([null, 'c1']);

    goOnline();
    expect(await screen.findByText(/Check complete\./u)).toBeVisible();
    expect(removeOff()).toBeEnabled();
    expect(asked).toEqual([null, 'c1', 'c1']);
  });

  it('of a restart goes back to checking, with Remove off', async () => {
    const { asked } = serveUsage({
      first: [page50, lastPage],
      c1: [workflowChanged],
    });
    const event = await openDialog({ onRemove: vi.fn() });
    const restart = await screen.findByRole('button', {
      name: 'Restart check',
    });

    goOffline();
    await event.click(restart);
    expect(await screen.findByText(/Checking workflows…/u)).toBeVisible();
    expect(removeOff()).toBeDisabled();

    goOnline();
    expect(await screen.findByText(/Check complete\./u)).toBeVisible();
    expect(asked).toEqual([null, 'c1', null]);
  });
});

describe('a finished check', () => {
  it('stays finished offline, and neither a reconnect nor a returning tab walks it again', async () => {
    const { asked } = serveUsage({
      first: [usagePage({ items: [reference('Invoice export')] })],
    });
    await openDialog({ onRemove: vi.fn() });
    await screen.findByText(/Check complete\./u);

    goOffline();
    await settle();
    expect(removeOff()).toBeEnabled();
    expect(screen.getByText(/Check complete\./u)).toBeVisible();

    goOnline();
    await settle();
    window.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(asked).toEqual([null]);
    expect(removeOff()).toBeEnabled();
  });
});
