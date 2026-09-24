import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../../src/components/ui/copy-button';
import { NotificationsProvider } from '../../src/components/ui/toast';
import { useCopyToClipboard } from '../../src/components/ui/use-copy-to-clipboard';
import { copyText } from '../../src/lib/clipboard';

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('copyText', () => {
  it('reports whether the browser let the text through', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    mockClipboard(writeText);
    await expect(copyText('run-1')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('run-1');

    mockClipboard(() => Promise.reject(new Error('blocked')));
    await expect(copyText('run-1')).resolves.toBe(false);

    Reflect.deleteProperty(navigator, 'clipboard');
    await expect(copyText('run-1')).resolves.toBe(false);
  });
});

describe('CopyButton', () => {
  it('names the value it shows and confirms in place', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    mockClipboard(writeText);
    render(
      <CopyButton value="eeee-full" label="Copy run ID" display="eeee…" />,
    );
    const button = screen.getByRole('button', { name: 'Copy run ID eeee…' });
    expect(button).toHaveTextContent('eeee…');
    await user.click(button);
    expect(writeText).toHaveBeenCalledWith('eeee-full');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it('says when the browser blocked the copy', async () => {
    const user = userEvent.setup();
    mockClipboard(() => Promise.reject(new Error('blocked')));
    render(<CopyButton value="secret" label="Copy signing secret" />);
    await user.click(
      screen.getByRole('button', { name: 'Copy signing secret' }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Couldn’t copy. Select the text instead.',
        }),
      ).toBeVisible();
    });
  });
});

function MenuCopy() {
  const copy = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() =>
        void copy('wf-1', 'workflow ID', {
          description: 'Invoice intake',
          elsewhere: 'Open Settings to copy it there.',
        })
      }
    >
      Copy ID
    </button>
  );
}

describe('useCopyToClipboard', () => {
  it('confirms a copy from a menu with a toast', async () => {
    const user = userEvent.setup();
    mockClipboard(() => Promise.resolve());
    render(
      <NotificationsProvider>
        <MenuCopy />
      </NotificationsProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Copy ID' }));
    expect((await screen.findAllByText('Workflow ID copied'))[0]).toBeVisible();
  });

  it('says where else to copy it when the browser blocks it', async () => {
    const user = userEvent.setup();
    mockClipboard(() => Promise.reject(new Error('blocked')));
    render(
      <NotificationsProvider>
        <MenuCopy />
      </NotificationsProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Copy ID' }));
    expect(
      (await screen.findAllByText('Couldn’t copy the workflow ID'))[0],
    ).toBeVisible();
    expect(
      screen.getAllByText(
        'Your browser blocked the clipboard. Open Settings to copy it there.',
      )[0],
    ).toBeVisible();
  });
});
