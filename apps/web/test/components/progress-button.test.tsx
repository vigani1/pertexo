import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProgressButton } from '@/components/ui/progress-button';

describe('command button feedback', () => {
  it('prioritizes an in-flight command, then its wait, before allowing another click', async () => {
    const actor = userEvent.setup(),
      onClick = vi.fn();
    const { rerender } = render(
      <ProgressButton
        pending
        pendingLabel="Saving…"
        waitSeconds={9}
        onClick={onClick}
      >
        Save
      </ProgressButton>,
    );
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await actor.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();

    rerender(
      <ProgressButton
        pendingLabel="Saving…"
        waitSeconds={9}
        waitLabel="Resend in"
        onClick={onClick}
      >
        Save
      </ProgressButton>,
    );
    expect(screen.getByRole('button', { name: /Resend in/u })).toBeDisabled();
    expect(screen.queryByText('Save')).toBeNull();
    await actor.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();

    rerender(
      <ProgressButton pendingLabel="Saving…" onClick={onClick}>
        Save
      </ProgressButton>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await actor.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps the owner’s disabled state after pending feedback ends', () => {
    render(
      <ProgressButton disabled pendingLabel="Saving…">
        Save
      </ProgressButton>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
