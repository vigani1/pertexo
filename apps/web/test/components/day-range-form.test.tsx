import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DayRangeForm } from '@/components/patterns/dates/day-range-form';
import { formatCalendarDay } from '@/lib/format/time';

const day = (date: number) => formatCalendarDay(new Date(2026, 8, date));

describe('DayRangeForm', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 20, 12));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a reopened range’s start when its last day is picked', async () => {
    const onApply = vi.fn<(from: string, to: string) => undefined>();
    render(
      <DayRangeForm
        initial={{ from: '2026-09-14', to: '' }}
        onApply={onApply}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: day(16) }));
    expect(onApply).toHaveBeenCalledWith('2026-09-14', '2026-09-16');
  });

  it('starts over from one day when nothing is open', async () => {
    const onApply = vi.fn<(from: string, to: string) => undefined>();
    render(
      <DayRangeForm
        initial={{ from: '2026-09-14', to: '2026-09-15' }}
        onApply={onApply}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: day(17) }));
    expect(onApply).toHaveBeenCalledWith('2026-09-17', '2026-09-17');
  });

  it('applies one tapped day at once, then extends it with a second tap', async () => {
    const onApply = vi.fn<(from: string, to: string) => undefined>();
    render(<DayRangeForm onApply={onApply} />);
    await userEvent.click(screen.getByRole('button', { name: day(18) }));
    expect(onApply).toHaveBeenLastCalledWith('2026-09-18', '2026-09-18');
    await userEvent.click(screen.getByRole('button', { name: day(12) }));
    expect(onApply).toHaveBeenLastCalledWith('2026-09-12', '2026-09-18');
    expect(onApply).toHaveBeenCalledTimes(2);
  });
});
