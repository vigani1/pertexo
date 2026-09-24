/**
 * One light passing over the canvas while the draft is checked. Decorative:
 * the issues chip says "Checking…" in words, and reduced motion hides it.
 */
export function ValidationSweep({ active }: Readonly<{ active: boolean }>) {
  if (!active) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 -left-32 z-[4] w-32 bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--primary)_6%,transparent)_70%,color-mix(in_srgb,var(--accent-foreground)_35%,transparent)_98%,transparent)] motion-safe:animate-[validation-sweep_3.2s_cubic-bezier(0.4,0,0.2,1)_1_forwards] motion-reduce:hidden"
    />
  );
}
