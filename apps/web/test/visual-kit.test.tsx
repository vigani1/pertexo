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
import { AuroraLoadingPanel } from '../src/components/patterns/aurora-loading-panel';

describe('ported visual primitives', () => {
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

  it('adds only a decorative border without remounting its children', async () => {
    const content = <Input aria-label="Preserved input" />;
    const { container, rerender } = render(
      <AuroraLoadingPanel active={false}>{content}</AuroraLoadingPanel>,
    );
    expect(container.querySelector('[data-slot="aurora-border"]')).toBeNull();
    await userEvent.setup().type(screen.getByRole('textbox'), 'Keep me');
    rerender(<AuroraLoadingPanel active>{content}</AuroraLoadingPanel>);
    expect(
      container.querySelector('[data-slot="aurora-border"]'),
    ).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('textbox')).toHaveValue('Keep me');
    rerender(<AuroraLoadingPanel active={false}>{content}</AuroraLoadingPanel>);
    expect(screen.getByRole('textbox')).toHaveValue('Keep me');
  });
});
