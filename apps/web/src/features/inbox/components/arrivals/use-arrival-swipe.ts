import { useCallback, useEffect, useRef, type PointerEvent } from 'react';

type SwipeDirection = 'left' | 'down';

/** How far toward the Inbox a drag must go to dismiss, as Base UI's toasts. */
const DRAG_THRESHOLD_PX = 40;
/** Trackpad swipes arrive in quick bursts, so they need to go further. */
const WHEEL_THRESHOLD_PX = 80;
/** A trackpad swipe that pauses this long without dismissing springs back. */
const WHEEL_SETTLE_MS = 160;
/** A swipe never starts on something that is itself pressed. */
const INTERACTIVE = 'button,a,input,textarea,select,[role="button"]';

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  along: number;
}

function place(element: HTMLElement, direction: SwipeDirection, along: number) {
  // The wrong way resists instead of moving freely.
  const offset = along >= 0 ? along : -Math.sqrt(-along) * 2;
  element.style.setProperty(
    '--arrival-drag-x',
    `${String(direction === 'left' ? -offset : 0)}px`,
  );
  element.style.setProperty(
    '--arrival-drag-y',
    `${String(direction === 'down' ? offset : 0)}px`,
  );
}

/** Leaves the direction on the element for the exit styles in `globals.css`. */
function dismiss(
  element: HTMLElement,
  direction: SwipeDirection,
  onSwipe: () => void,
) {
  delete element.dataset.dragging;
  element.dataset.swiped = direction;
  onSwipe();
}

function settle(element: HTMLElement, direction: SwipeDirection) {
  delete element.dataset.dragging;
  place(element, direction, 0);
}

/**
 * Two-finger trackpad swipes arrive as wheel events, not drags. They move
 * the notice the way the fingers go under macOS natural scrolling. The
 * listener is not passive, so a sideways swipe over the notice never
 * becomes the browser's swipe-back navigation.
 */
function listenForWheelSwipes(
  element: HTMLElement,
  direction: SwipeDirection,
  onSwipe: () => void,
): () => void {
  let along = 0;
  let timer: number | undefined;
  let dismissed = false;
  const onWheel = (event: WheelEvent) => {
    // A pinch arrives as a wheel event with Control held.
    if (dismissed || event.ctrlKey) return;
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (sideways !== (direction === 'left')) return;
    event.preventDefault();
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    along += (direction === 'left' ? event.deltaX : -event.deltaY) * scale;
    window.clearTimeout(timer);
    if (along > WHEEL_THRESHOLD_PX) {
      dismissed = true;
      dismiss(element, direction, onSwipe);
      return;
    }
    element.dataset.dragging = '';
    place(element, direction, along);
    timer = window.setTimeout(() => {
      along = 0;
      settle(element, direction);
    }, WHEEL_SETTLE_MS);
  };
  element.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    element.removeEventListener('wheel', onWheel);
    window.clearTimeout(timer);
  };
}

/**
 * Base UI turns swiping off for anchored toasts, so the arrival notice
 * brings its own: drag it, or swipe two fingers on a trackpad, toward the
 * Inbox to dismiss it. A short swipe springs back.
 */
export function useArrivalSwipe(
  direction: SwipeDirection | undefined,
  onSwipe: () => void,
) {
  const drag = useRef<Drag | undefined>(undefined);
  const latestOnSwipe = useRef(onSwipe);
  useEffect(() => {
    latestOnSwipe.current = onSwipe;
  });
  const ref = useCallback(
    (element: HTMLElement | null) => {
      if (element === null || direction === undefined) return;
      return listenForWheelSwipes(element, direction, () => {
        latestOnSwipe.current();
      });
    },
    [direction],
  );

  const finish = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    const current = drag.current;
    if (direction === undefined || current?.pointerId !== event.pointerId)
      return;
    drag.current = undefined;
    if (commit && current.along > DRAG_THRESHOLD_PX)
      dismiss(event.currentTarget, direction, onSwipe);
    else settle(event.currentTarget, direction);
  };

  if (direction === undefined) return {};
  return {
    ref,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE))
        return;
      drag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        along: 0,
      };
      event.currentTarget.dataset.dragging = '';
      // Not every environment implements pointer capture.
      if (typeof event.currentTarget.setPointerCapture === 'function')
        event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (current?.pointerId !== event.pointerId) return;
      current.along =
        direction === 'left'
          ? current.x - event.clientX
          : event.clientY - current.y;
      place(event.currentTarget, direction, current.along);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      finish(event, true);
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      finish(event, false);
    },
  };
}
