/**
 * One light passing over the canvas while the draft is checked. Decorative:
 * the issues chip says "Checking…" in words, and reduced motion hides it.
 */
export function ValidationSweep({ active }: Readonly<{ active: boolean }>) {
  if (!active) return null;
  return (
    // A full-width layer whose light sits in its last 8rem, moved only with
    // transform, so the sweep never counts as a layout shift.
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[4] validation-thread-paint will-change-transform motion-safe:animate-[validation-sweep_3.2s_cubic-bezier(0.4,0,0.2,1)_1_forwards] motion-reduce:hidden"
    />
  );
}
