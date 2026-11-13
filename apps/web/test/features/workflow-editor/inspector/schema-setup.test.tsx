import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NewStep } from './schema-setup.fixture';
import { choose, optionsOf, saved } from './schema-setup-actions';

describe('step setup drawn from the catalog schema', () => {
  it.each([
    {
      key: 'core.text',
      label: 'Operation',
      shown: 'Trim whitespace',
      options: [
        'Uppercase',
        'Lowercase',
        'Trim whitespace',
        'Replace text',
        'Split text',
        'Truncate text',
      ],
      help: /Matches are literal, never regex/u,
    },
    {
      key: 'core.date',
      label: 'Date operation',
      shown: 'ISO timestamp (UTC)',
      options: [
        'ISO timestamp (UTC)',
        'Epoch milliseconds',
        'Format timestamp',
        'Convert time zone',
        'Add or subtract duration',
      ],
      help: /a time with its offset like 2026-10-19T09:30:00\+02:00/u,
    },
    {
      key: 'core.number',
      label: 'Operation',
      shown: 'Decimal',
      options: ['Decimal', 'Percent', 'Currency'],
      help: /Percent formats 0.25 as 25%/u,
    },
    {
      key: 'core.crypto',
      label: 'Operation',
      shown: 'Hash text',
      options: ['Hash text', 'UUID', 'Random ID'],
      help: /UUID and random IDs change/u,
    },
    {
      key: 'core.xml',
      label: 'Operation',
      shown: 'XML to JSON',
      options: ['XML to JSON', 'JSON to XML'],
      help: /DTDs are not supported/u,
    },
    {
      key: 'core.html',
      label: 'Operation',
      shown: 'Extract text',
      options: ['Extract text', 'Extract attribute'],
      help: /Scripts never run/u,
    },
  ])(
    'shows $key with its words, choices and starting operation',
    async ({ key, label, shown, options, help }) => {
      render(<NewStep stepKey={key} />);
      const choice = screen.getByRole('combobox', { name: label });
      expect(choice).toHaveTextContent(shown);
      expect(screen.getByText(help)).toBeInTheDocument();
      expect(await optionsOf(label)).toEqual(options);
    },
  );

  it('shows each operation’s own settings with their starting values', async () => {
    render(<NewStep stepKey="core.number" />);
    expect(screen.getByRole('combobox', { name: 'Locale' })).toHaveTextContent(
      'en-US',
    );
    expect(screen.getByRole('switch', { name: 'Grouping' })).toBeChecked();
    expect(
      screen.getByRole('textbox', { name: 'Maximum fraction digits' }),
    ).toHaveValue('2');
    expect(screen.queryByRole('textbox', { name: 'Currency' })).toBeNull();
    await choose('Operation', 'Currency');
    expect(screen.getByRole('textbox', { name: 'Currency' })).toHaveValue(
      'USD',
    );
  });

  it('keeps the values two operations share and drops the rest', async () => {
    const user = userEvent.setup();
    render(<NewStep stepKey="core.date" />);
    await choose('Date operation', 'Format timestamp');
    expect(saved()).toEqual({
      operation: 'format',
      format: 'date_only',
      timeZone: 'UTC',
    });
    expect(screen.getByRole('combobox', { name: 'Format' })).toHaveTextContent(
      'Date only (YYYY-MM-DD)',
    );
    const zone = screen.getByRole('textbox', { name: 'Time zone' });
    await user.clear(zone);
    await user.type(zone, 'Europe/Paris');
    await choose('Date operation', 'Convert time zone');
    expect(saved()).toEqual({
      operation: 'convert_timezone',
      timeZone: 'Europe/Paris',
    });
    await choose('Date operation', 'Add or subtract duration');
    expect(saved()).toEqual({ operation: 'add_duration', unit: 'days' });
    expect(screen.queryByRole('textbox', { name: 'Time zone' })).toBeNull();
    expect(
      screen.getByRole('combobox', { name: 'Duration unit' }),
    ).toHaveTextContent('Days (24 hours)');
  });

  it('reads an operation’s help with its choice', () => {
    render(<NewStep stepKey="core.crypto" />);
    expect(
      screen.getByRole('combobox', { name: 'Operation' }),
    ).toHaveAccessibleDescription(
      'MD5 is not for security. UUID and random IDs change whenever this step runs again.',
    );
    expect(
      screen.getByRole('combobox', { name: 'Algorithm' }),
    ).toHaveAccessibleDescription(
      'MD5 is not for security. Use SHA-256 or SHA-512 for security-sensitive hashes.',
    );
  });

  it('names stored choice IDs in words on a flat setup', async () => {
    render(<NewStep stepKey="core.filter" />);
    expect(
      screen.getByRole('combobox', { name: 'Comparison' }),
    ).toHaveTextContent('Equals');
    expect(await optionsOf('Comparison')).toContain('Field is missing');
    expect(
      screen.getByText(
        'Use $ for each whole item, or a path like $.paid for one field.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/only be edited as JSON/u)).toBeNull();
  });
});
