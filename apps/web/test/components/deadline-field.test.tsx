import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  monthWeeks,
  normalizeClock,
  shiftDays,
  shiftMonths,
} from '../../src/components/ui/date-time-parts';
import { DeadlineField } from '../../src/components/ui/deadline-field';

function Harness({ initial = '' }: Readonly<{ initial?: string }>) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <DeadlineField
        value={value}
        error={undefined}
        disabled={false}
        register={() => undefined}
        onChange={setValue}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

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

describe('DeadlineField', () => {
  it('offers none, an hour, a day or a time of your own', async () => {
    const event = userEvent.setup();
    render(<Harness />);
    const deadline = screen.getByRole('group', { name: 'Deadline (optional)' });
    expect(deadline).toHaveTextContent('Without one, the run has no deadline.');
    await event.click(
      within(deadline).getByRole('button', { name: 'In 1 hour' }),
    );
    expect(screen.getByTestId('value')).toHaveTextContent(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d[05]$/u,
    );
    expect(deadline).toHaveTextContent(
      /The run stops at .+ if it isn’t finished/u,
    );
    await event.click(within(deadline).getByRole('button', { name: 'None' }));
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();
  });

  it('takes a typed date and tidies the time when it’s left', async () => {
    const event = userEvent.setup();
    render(<Harness />);
    await event.click(screen.getByRole('button', { name: 'Pick a time' }));
    await event.type(screen.getByLabelText('Deadline date'), '2030-03-04');
    await event.type(screen.getByLabelText('Deadline time'), '930');
    await event.tab();
    expect(screen.getByTestId('value')).toHaveTextContent('2030-03-04T09:30');
  });

  it('picks the date from a calendar, from the keyboard too', async () => {
    const event = userEvent.setup();
    render(<Harness initial="2030-03-04T18:00" />);
    await event.click(
      screen.getByRole('button', { name: 'Choose the date from a calendar' }),
    );
    const grid = await screen.findByRole('grid');
    within(grid).getByRole('button', { pressed: true }).focus();
    await event.keyboard('{ArrowRight}{ArrowDown}{Enter}');
    expect(screen.getByTestId('value')).toHaveTextContent('2030-03-12T18:00');
  });
});
