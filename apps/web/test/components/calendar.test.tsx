import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Calendar } from '@/components/ui/calendar';
import { formatCalendarDay } from '@/lib/format-time';

const day = (date: number) => formatCalendarDay(new Date(2026, 8, date));

describe('Calendar', () => {
  it('marks a range’s ends, shades its middle and keeps days past max out of reach', async () => {
    const onSelect = vi.fn();
    render(
      <Calendar
        value={undefined}
        max="2026-09-20"
        range={{ from: '2026-09-14', to: '2026-09-16' }}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('button', { name: day(14) })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: day(16) })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const middle = screen.getByRole('button', { name: day(15) });
    expect(middle).toHaveAttribute('aria-pressed', 'false');
    expect(middle.className).toMatch(/bg-action\/15/u);
    expect(screen.getByRole('button', { name: day(21) })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: day(18) }));
    expect(onSelect).toHaveBeenCalledWith('2026-09-18');
  });
});
