import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../src/components/ui/button';
import { buttonVariants } from '../src/components/ui/button-variants';
import { Input } from '../src/components/ui/input';
import { Textarea } from '../src/components/ui/textarea';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../src/components/ui/field';
import { LoadingOrb } from '../src/components/ui/loading-orb';
import { Status } from '../src/components/ui/status';
import { FieldControl } from '../src/components/ui/field';

describe('Weft visual primitives', () => {
  it('labels a status with its word and keeps the glyph decorative', () => {
    const { container } = render(<Status tone="failure">Failed</Status>);
    expect(screen.getByText('Failed')).toBeVisible();
    expect(
      container.querySelector('[data-slot="status-glyph"]'),
    ).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('[data-slot="status"]')).toHaveAttribute(
      'data-tone',
      'failure',
    );
  });

  it('marks field validation visually without changing the control', async () => {
    const { container } = render(
      <FieldControl state="invalid">
        <Input aria-label="Email" aria-invalid="true" />
      </FieldControl>,
    );
    expect(
      container.querySelector('[data-slot="field-control"]'),
    ).toHaveAttribute('data-state', 'invalid');
    await userEvent
      .setup()
      .type(screen.getByRole('textbox', { name: 'Email' }), 'a@b.dev');
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue(
      'a@b.dev',
    );
  });

  it('keeps destructive actions disabled and styled links semantic', async () => {
    const click = vi.fn();
    render(
      <>
        <Button variant="destructive" disabled onClick={click}>
          Revoke
        </Button>
        <a href="#details" className={buttonVariants({ variant: 'outline' })}>
          Details
        </a>
      </>,
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Revoke' }));
    expect(click).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Details' })).toHaveAttribute(
      'href',
      '#details',
    );
  });

  it('preserves input refs, native attributes and typing behavior', async () => {
    const input = createRef<HTMLInputElement>();
    const textarea = createRef<HTMLTextAreaElement>();
    render(
      <>
        <Input ref={input} aria-label="Name" maxLength={8} />
        <Textarea ref={textarea} aria-label="Description" disabled />
      </>,
    );
    await userEvent
      .setup()
      .type(screen.getByRole('textbox', { name: 'Name' }), 'Example');
    expect(input.current?.value).toBe('Example');
    expect(input.current).toHaveAttribute('maxlength', '8');
    expect(textarea.current).toBeDisabled();
  });

  it('keeps field labels and descriptions associated with their control', () => {
    render(
      <FieldGroup>
        <Field data-invalid>
          <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
          <Input
            id="workspace-name"
            aria-invalid="true"
            aria-describedby="workspace-name-hint workspace-name-error"
          />
          <FieldDescription id="workspace-name-hint">
            Visible to workspace members.
          </FieldDescription>
          <FieldError id="workspace-name-error">Enter a name.</FieldError>
        </Field>
      </FieldGroup>,
    );
    expect(
      screen.getByRole('textbox', { name: 'Workspace name' }),
    ).toHaveAccessibleDescription(
      'Visible to workspace members. Enter a name.',
    );
  });

  it('keeps the compact loading orb decorative', () => {
    const { container } = render(
      <button type="button">
        <LoadingOrb />
        Signing in…
      </button>,
    );

    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeVisible();
    expect(
      container.querySelector('[data-slot="loading-orb"]'),
    ).toHaveAttribute('aria-hidden', 'true');
  });
});
