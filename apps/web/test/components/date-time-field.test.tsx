import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  localDateOf,
  monthWeeks,
  normalizeClock,
  shiftDays,
  shiftMonths,
} from '../../src/components/ui/date-time-parts';
import { DateTimeField } from '../../src/components/ui/date-time-field';

function Harness({ initial = '' }: Readonly<{ initial?: string }>) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="deadline">Deadline</label>
      <DateTimeField
        id="deadline"
        value={value}
        timeLabel="Deadline time"
        onValueChange={setValue}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

const today = localDateOf(new Date());

describe('date and time parts', () => {
  it('reads the times people type', () => {
    expect(normalizeClock('9')).toBe('09:00');
    expect(normalizeClock('930')).toBe('09:30');
    expect(normalizeClock('21:5')).toBe('21:05');
    expect(normalizeClock('2359')).toBe('23:59');
    expect(normalizeClock('24:00')).toBeUndefined();
    expect(normalizeClock('noon')).toBeUndefined();
  });

  it('lays a month out in Monday-first weeks and keeps days valid', () => {
    const weeks = monthWeeks('2026-09-25');
    expect(weeks[0]?.[0]).toBe('2026-08-31');
    expect(weeks.at(-1)?.at(-1)).toBe('2026-10-04');
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(shiftDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});

describe('DateTimeField', () => {
  it('names the day button by its label and reads the chosen day', () => {
    render(<Harness initial="2030-03-04T09:30" />);
    const day = screen.getByRole('button', { name: 'Deadline' });
    expect(day).toHaveAccessibleDescription(/2030/u);
    expect(screen.getByLabelText('Deadline time')).toHaveValue('09:30');
  });

  it('assumes today for a typed time and tidies it when left', async () => {
    const event = userEvent.setup();
    render(<Harness />);
    await event.type(screen.getByLabelText('Deadline time'), '930');
    await event.tab();
    expect(screen.getByTestId('value')).toHaveTextContent(`${today}T09:30`);
  });

  it('picks a day from the calendar, from the keyboard too', async () => {
    const event = userEvent.setup();
    render(<Harness initial="2030-03-04T18:00" />);
    await event.click(screen.getByRole('button', { name: 'Deadline' }));
    const grid = await screen.findByRole('grid');
    const current = within(grid).getByRole('button', { pressed: true });
    current.focus();
    await event.keyboard('{ArrowRight}{ArrowDown}');
    await event.keyboard('{Enter}');
    expect(screen.getByTestId('value')).toHaveTextContent('2030-03-12T18:00');
  });

  it('clears the date and time together', async () => {
    const event = userEvent.setup();
    render(<Harness initial="2030-03-04T18:00" />);
    await event.click(
      screen.getByRole('button', { name: 'Clear the date and time' }),
    );
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();
    expect(
      screen.getByRole('button', { name: 'Deadline' }),
    ).toHaveAccessibleDescription('No date');
  });
});
