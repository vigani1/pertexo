import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useArrivalSwipe } from '@/features/inbox/components/arrivals/use-arrival-swipe';

function Notice({
  direction,
  onSwipe,
}: Readonly<{ direction: 'left' | 'down'; onSwipe: () => void }>) {
  const swipe = useArrivalSwipe(direction, onSwipe);
  return (
    <div data-testid="notice" {...swipe}>
      <p>Nightly import</p>
      <button type="button">Open run</button>
    </div>
  );
}

function drag(
  target: Element,
  from: Readonly<{ x: number; y: number }>,
  to: Readonly<{ x: number; y: number }>,
) {
  const notice = screen.getByTestId('notice');
  fireEvent.pointerDown(target, {
    button: 0,
    pointerId: 1,
    clientX: from.x,
    clientY: from.y,
  });
  fireEvent.pointerMove(notice, { pointerId: 1, clientX: to.x, clientY: to.y });
  const offset = {
    x: notice.style.getPropertyValue('--arrival-drag-x'),
    y: notice.style.getPropertyValue('--arrival-drag-y'),
  };
  fireEvent.pointerUp(notice, { pointerId: 1, clientX: to.x, clientY: to.y });
  return offset;
}

describe('arrival notice swipe', () => {
  it('follows a drag toward the Inbox and dismisses past the threshold', () => {
    const onSwipe = vi.fn();
    render(<Notice direction="left" onSwipe={onSwipe} />);
    const notice = screen.getByTestId('notice');

    const held = drag(
      screen.getByText('Nightly import'),
      { x: 200, y: 100 },
      { x: 120, y: 100 },
    );

    expect(held).toEqual({ x: '-80px', y: '0px' });
    expect(onSwipe).toHaveBeenCalledOnce();
    expect(notice).toHaveAttribute('data-swiped', 'left');
  });

  it('springs back from a short drag', () => {
    const onSwipe = vi.fn();
    render(<Notice direction="left" onSwipe={onSwipe} />);
    const notice = screen.getByTestId('notice');

    drag(notice, { x: 200, y: 100 }, { x: 175, y: 100 });

    expect(onSwipe).not.toHaveBeenCalled();
    expect(notice.style.getPropertyValue('--arrival-drag-x')).toBe('0px');
    expect(notice).not.toHaveAttribute('data-swiped');
  });

  it('resists a drag away from the Inbox and never dismisses it', () => {
    const onSwipe = vi.fn();
    render(<Notice direction="left" onSwipe={onSwipe} />);
    const notice = screen.getByTestId('notice');

    const held = drag(notice, { x: 200, y: 100 }, { x: 300, y: 100 });

    expect(held.x).toBe('20px');
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('never starts on a button inside the notice', () => {
    const onSwipe = vi.fn();
    render(<Notice direction="left" onSwipe={onSwipe} />);

    drag(
      screen.getByRole('button', { name: 'Open run' }),
      { x: 200, y: 100 },
      { x: 60, y: 100 },
    );

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('swipes down into the phone bar', () => {
    const onSwipe = vi.fn();
    render(<Notice direction="down" onSwipe={onSwipe} />);

    const held = drag(
      screen.getByTestId('notice'),
      { x: 100, y: 100 },
      { x: 100, y: 160 },
    );

    expect(held).toEqual({ x: '0px', y: '60px' });
    expect(onSwipe).toHaveBeenCalledOnce();
  });

  describe('with a trackpad', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('dismisses a two-finger swipe toward the Inbox and keeps it from navigating back', () => {
      const onSwipe = vi.fn();
      render(<Notice direction="left" onSwipe={onSwipe} />);
      const notice = screen.getByTestId('notice');

      expect(fireEvent.wheel(notice, { deltaX: 30 })).toBe(false);
      expect(notice.style.getPropertyValue('--arrival-drag-x')).toBe('-30px');
      fireEvent.wheel(notice, { deltaX: 30 });
      fireEvent.wheel(notice, { deltaX: 30 });

      expect(onSwipe).toHaveBeenCalledOnce();
      expect(notice).toHaveAttribute('data-swiped', 'left');
    });

    it('springs back when a short swipe stops', () => {
      vi.useFakeTimers();
      const onSwipe = vi.fn();
      render(<Notice direction="left" onSwipe={onSwipe} />);
      const notice = screen.getByTestId('notice');

      fireEvent.wheel(notice, { deltaX: 30 });
      vi.advanceTimersByTime(200);

      expect(notice.style.getPropertyValue('--arrival-drag-x')).toBe('0px');
      expect(onSwipe).not.toHaveBeenCalled();
    });

    it('leaves scrolling and pinching over the notice alone', () => {
      const onSwipe = vi.fn();
      render(<Notice direction="left" onSwipe={onSwipe} />);
      const notice = screen.getByTestId('notice');

      expect(fireEvent.wheel(notice, { deltaY: 200 })).toBe(true);
      expect(fireEvent.wheel(notice, { deltaX: 200, ctrlKey: true })).toBe(
        true,
      );

      expect(onSwipe).not.toHaveBeenCalled();
      expect(notice.style.getPropertyValue('--arrival-drag-x')).toBe('');
    });
  });
});
