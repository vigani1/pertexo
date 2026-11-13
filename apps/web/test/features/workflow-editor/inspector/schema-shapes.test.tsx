import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Fields } from './schema-setup.fixture';
import { choose, saved } from './schema-setup-actions';

describe('shapes the generic setup draws', () => {
  it('draws one level of nested object as a named group', async () => {
    const user = userEvent.setup();
    render(
      <Fields
        schema={{
          type: 'object',
          properties: {
            retry: {
              type: 'object',
              title: 'Retry',
              properties: {
                attempts: { type: 'integer', title: 'Attempts', minimum: 1 },
                backoff: {
                  type: 'string',
                  enum: ['fixed', 'exponential'],
                  oneOf: [
                    { const: 'fixed', title: 'Fixed delay' },
                    { const: 'exponential', title: 'Doubling delay' },
                  ],
                },
              },
              required: ['attempts'],
            },
          },
        }}
      />,
    );
    const group = screen.getByRole('group', { name: 'Retry' });
    await user.type(
      within(group).getByRole('textbox', { name: 'Attempts' }),
      '3',
    );
    expect(saved()).toEqual({ retry: { attempts: 3 } });
    await choose('Backoff', 'Doubling delay');
    expect(saved()).toEqual({ retry: { attempts: 3, backoff: 'exponential' } });
    await user.clear(within(group).getByRole('textbox', { name: 'Attempts' }));
    await choose('Backoff', 'Not set');
    // Clearing the last value removes the group, not leaves `{}` behind.
    expect(saved()).toEqual({});
    expect(screen.queryByText(/only be edited as JSON/u)).toBeNull();
  });

  it('reads each field’s help, and its error, with the field', async () => {
    const user = userEvent.setup();
    render(
      <Fields
        schema={{
          type: 'object',
          properties: {
            name: {
              type: 'string',
              title: 'Name',
              description: 'Shown to people.',
            },
            strict: {
              type: 'boolean',
              title: 'Strict',
              description: 'Refuse unknown fields.',
            },
            mode: {
              type: 'string',
              enum: ['fast', 'safe'],
              title: 'Mode',
              description: 'Safe checks twice.',
            },
            timeoutMillis: {
              type: 'integer',
              minimum: 1,
              maximum: 30_000,
              description: 'How long to wait.',
            },
            retry: {
              type: 'object',
              title: 'Retry',
              properties: {
                attempts: {
                  type: 'integer',
                  title: 'Attempts',
                  description: 'Tries before giving up.',
                },
              },
            },
          },
        }}
      />,
    );
    expect(
      screen.getByRole('textbox', { name: 'Name' }),
    ).toHaveAccessibleDescription('Shown to people.');
    expect(
      screen.getByRole('switch', { name: 'Strict' }),
    ).toHaveAccessibleDescription('Refuse unknown fields.');
    expect(
      screen.getByRole('combobox', { name: 'Mode' }),
    ).toHaveAccessibleDescription('Safe checks twice.');
    expect(
      screen.getByRole('textbox', { name: 'Attempts' }),
    ).toHaveAccessibleDescription('Tries before giving up.');
    const timeout = screen.getByRole('textbox', { name: /^Timeout/u });
    expect(timeout).toHaveAccessibleDescription('How long to wait.');
    await user.type(timeout, 'x');
    await user.tab();
    expect(timeout).toHaveAccessibleDescription(
      'How long to wait. Timeout must be a number.',
    );
  });

  it('keeps shapes it can’t draw on Edit as JSON', () => {
    render(
      <Fields
        schema={{
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name' },
            deep: {
              type: 'object',
              properties: { inner: { type: 'object', properties: {} } },
            },
            tags: { type: 'array', items: { type: 'string' } },
          },
        }}
        start={{ tags: ['a'] }}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    expect(screen.queryByRole('group')).toBeNull();
    expect(
      screen.getByText('Some settings can only be edited as JSON.'),
    ).toBeInTheDocument();
    expect(saved()).toEqual({ tags: ['a'] });
  });
});
