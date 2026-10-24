import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Disclosure } from '../../src/components/ui/disclosure';
import { LabelledField } from '../../src/components/ui/field';
import { Input } from '../../src/components/ui/input';

describe('composed field content', () => {
  it('keeps label actions, trailing controls and feedback with the labelled input', async () => {
    const user = userEvent.setup();
    render(
      <>
        <p id="meter">Strong password</p>
        <LabelledField
          id="secret"
          label="Password"
          labelAction={<a href="#reset">Forgot?</a>}
          trailing={<button type="button">Show</button>}
          feedback={<p>Strength feedback</p>}
          description="Use twelve characters."
          error="Try a longer password."
          describedBy="meter"
        >
          {(control) => <Input {...control} />}
        </LabelledField>
      </>,
    );
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      'Strong password Use twelve characters. Try a longer password.',
    );
    expect(screen.getByText('Strength feedback')).toBeVisible();
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Show' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Forgot?' })).toHaveFocus();
  });

  it('mounts a lazy disclosure when opened and removes its content when closed', async () => {
    const user = userEvent.setup();
    render(
      <Disclosure
        summary="More detail"
        lazy
        look="framed"
        size="xs"
        tone="link"
      >
        <button type="button">Inspect detail</button>
      </Disclosure>,
    );
    expect(screen.queryByRole('button', { name: 'Inspect detail' })).toBeNull();
    await user.click(screen.getByText('More detail'));
    expect(
      await screen.findByRole('button', { name: 'Inspect detail' }),
    ).toBeVisible();
    await user.click(screen.getByText('More detail'));
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Inspect detail' }),
      ).toBeNull();
    });
  });

  it('mounts a default-open lazy disclosure immediately', () => {
    render(
      <Disclosure summary="More detail" lazy defaultOpen>
        <p>Already open</p>
      </Disclosure>,
    );
    expect(screen.getByText('Already open')).toBeVisible();
  });
});
