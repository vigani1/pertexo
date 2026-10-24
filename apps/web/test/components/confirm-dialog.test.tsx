import { useState, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ConfirmDialog,
  ConfirmationDetails,
  ConfirmationFooter,
} from '../../src/components/patterns/actions/confirm-dialog';
import { Button } from '../../src/components/ui/button';
import { DialogClose } from '../../src/components/ui/dialog';
import { ProgressButton } from '../../src/components/ui/progress-button';

function Harness({
  pending = false,
  error,
  unconfirmed,
  onConfirm,
  options,
}: Readonly<{
  pending?: boolean;
  error?: string;
  unconfirmed?: { onRetry: () => void; onDismiss: () => void };
  onConfirm: () => unknown;
  options?: {
    locked?: boolean;
    confirmDisabled?: boolean;
    onCancel?: () => void;
    children?: ReactNode;
    secondaryAction?: ReactNode;
    consequences?: readonly string[];
    errorTone?: 'destructive' | 'warning';
    errorAction?: ReactNode;
  };
}>) {
  const [open, setOpen] = useState(false);
  const locked = options?.locked ?? pending;
  let cancelButton: ReactNode;
  if (unconfirmed !== undefined) {
    cancelButton = (
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          unconfirmed.onDismiss();
          setOpen(false);
        }}
      >
        Close
      </Button>
    );
  } else if (options?.onCancel !== undefined) {
    cancelButton = (
      <Button type="button" variant="ghost" onClick={options.onCancel}>
        Cancel
      </Button>
    );
  } else {
    cancelButton = (
      <DialogClose
        disabled={locked}
        render={<Button type="button" variant="ghost" />}
      >
        Cancel
      </DialogClose>
    );
  }
  return (
    <ConfirmDialog
      state={{ open, onOpenChange: setOpen, locked }}
      trigger={<Button type="button">Revoke</Button>}
      title="Revoke Slack?"
      description="Steps that use it stop working."
      onSubmit={unconfirmed?.onRetry ?? onConfirm}
      submitDisabled={pending || (options?.confirmDisabled ?? false)}
      footer={
        <ConfirmationFooter>
          {cancelButton}
          {options?.secondaryAction}
          <ProgressButton
            type="submit"
            variant="destructive"
            pending={pending}
            pendingLabel="Revoking…"
            disabled={options?.confirmDisabled}
          >
            {unconfirmed === undefined ? 'Revoke connection' : 'Try again'}
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        consequences={options?.consequences}
        error={error}
        tone={
          unconfirmed === undefined
            ? (options?.errorTone ?? 'destructive')
            : 'warning'
        }
        errorAction={options?.errorAction}
      >
        {options?.children}
      </ConfirmationDetails>
    </ConfirmDialog>
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
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeVisible();
    });
    expect(rejection).not.toHaveBeenCalled();
    window.removeEventListener('unhandledrejection', rejection);
  });

  it('submits from an input with Enter and blocks disabled and pending submits', async () => {
    const confirm = vi.fn();
    const user = userEvent.setup();
    const input = <input aria-label="Confirmation text" />;
    const { rerender } = render(
      <Harness onConfirm={confirm} options={{ children: input }} />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.type(screen.getByRole('textbox'), 'yes{Enter}');
    expect(confirm).toHaveBeenCalledOnce();
    rerender(
      <Harness
        onConfirm={confirm}
        options={{ children: input, confirmDisabled: true }}
      />,
    );
    await user.type(screen.getByRole('textbox'), '{Enter}');
    expect(
      screen.getByRole('button', { name: 'Revoke connection' }),
    ).toBeDisabled();
    expect(confirm).toHaveBeenCalledOnce();
    rerender(
      <Harness pending onConfirm={confirm} options={{ children: input }} />,
    );
    await user.type(screen.getByRole('textbox'), '{Enter}');
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('locks dismissal independently of submission', async () => {
    const confirm = vi.fn();
    const user = userEvent.setup();
    render(<Harness onConfirm={confirm} options={{ locked: true }} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Revoke connection' }));
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('keeps a custom cancel active while locked and leaves closing to its caller', async () => {
    const cancel = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness pending onConfirm={vi.fn()} options={{ onCancel: cancel }} />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('renders consequences, inputs, error actions and a separate secondary command', async () => {
    const secondary = vi.fn();
    const action = vi.fn();
    const confirm = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        error="Check this first"
        onConfirm={confirm}
        options={{
          consequences: ['Existing steps retain their history.'],
          children: <input aria-label="Reason" />,
          errorTone: 'warning',
          errorAction: (
            <button type="button" onClick={action}>
              Review
            </button>
          ),
          secondaryAction: (
            <button type="button" onClick={secondary}>
              Leave anyway
            </button>
          ),
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Existing steps retain their history.',
    );
    expect(screen.getByRole('textbox', { name: 'Reason' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Check this first');
    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Leave anyway' }));
    expect(action).toHaveBeenCalledOnce();
    expect(secondary).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('honors an explicit unlocked state even when a command is pending', async () => {
    const user = userEvent.setup();
    render(<Harness pending onConfirm={vi.fn()} options={{ locked: false }} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('uses exact retry for Enter and keeps unconfirmed dismissal active while pending', async () => {
    const retry = vi.fn();
    const dismiss = vi.fn();
    const confirm = vi.fn();
    const user = userEvent.setup();
    const input = <input aria-label="Confirmation text" />;
    const { rerender } = render(
      <Harness
        onConfirm={confirm}
        unconfirmed={{ onRetry: retry, onDismiss: dismiss }}
        options={{ children: input }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.type(screen.getByRole('textbox'), 'yes{Enter}');
    expect(retry).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    rerender(
      <Harness
        pending
        onConfirm={confirm}
        unconfirmed={{ onRetry: retry, onDismiss: dismiss }}
        options={{ children: input }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(dismiss).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
