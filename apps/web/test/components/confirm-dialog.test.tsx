import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../src/components/patterns/confirm-dialog';
import { Button } from '../../src/components/ui/button';

function Harness({
  pending = false,
  error,
  unconfirmed,
  onConfirm,
}: Readonly<{
  pending?: boolean;
  error?: string;
  unconfirmed?: { onRetry: () => void; onDismiss: () => void };
  onConfirm: () => unknown;
}>) {
  const [open, setOpen] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button type="button">Revoke</Button>}
      title="Revoke Slack?"
      description="Steps that use it stop working."
      tone="destructive"
      confirmLabel="Revoke connection"
      pendingLabel="Revoking…"
      pending={pending}
      error={error}
      unconfirmed={unconfirmed}
      onConfirm={onConfirm}
    />
  );
}

describe('ConfirmDialog', () => {
  it('opens from its trigger and confirms', async () => {
    const confirm = vi.fn();
    const user = userEvent.setup();
    render(<Harness onConfirm={confirm} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke Slack?' });
    expect(dialog).toHaveTextContent('Steps that use it stop working.');
    await user.click(screen.getByRole('button', { name: 'Revoke connection' }));
    expect(confirm).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('stays open while pending and swaps the verb', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness onConfirm={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    rerender(<Harness pending onConfirm={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Revoking…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('shows one failure and offers only the exact retry when unconfirmed', async () => {
    const retry = vi.fn();
    const dismiss = vi.fn();
    const confirm = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Harness onConfirm={confirm} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    rerender(
      <Harness
        error="We couldn’t confirm whether it was revoked."
        unconfirmed={{ onRetry: retry, onDismiss: dismiss }}
        onConfirm={confirm}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'We couldn’t confirm whether it was revoked.',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(dismiss).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('keeps success effects that follow the command after it unmounts', async () => {
    let finish: (() => void) | undefined;
    const announced = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <Harness
        onConfirm={async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          announced();
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Revoke connection' }));
    // The command's own cache update can take the dialog with it.
    unmount();
    finish?.();
    await waitFor(() => {
      expect(announced).toHaveBeenCalledOnce();
    });
  });

  it('swallows a rejected command so its error can render instead', async () => {
    const user = userEvent.setup();
    const rejection = vi.fn();
    window.addEventListener('unhandledrejection', rejection);
    render(<Harness onConfirm={() => Promise.reject(new Error('nope'))} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Revoke connection' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejection).not.toHaveBeenCalled();
    window.removeEventListener('unhandledrejection', rejection);
  });
});
