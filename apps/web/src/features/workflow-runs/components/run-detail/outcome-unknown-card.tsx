import { StatusGlyph } from '@/components/ui/status';

/**
 * An unknown outcome isn't a failure: Pertexo lost contact mid-step. Say so
 * plainly and warn before a replay repeats a side effect.
 */
export function OutcomeUnknownCard({
  stepLabel,
}: Readonly<{ stepLabel: string | undefined }>) {
  const step = stepLabel ?? 'a step';
  return (
    <section
      aria-labelledby="outcome-unknown-title"
      className="flex gap-3 rounded-xl border border-warning/30 bg-warning/[0.06] p-4"
    >
      <StatusGlyph tone="attention" className="mt-0.5 text-warning" />
      <div className="text-sm leading-relaxed">
        <h2
          id="outcome-unknown-title"
          className="font-sans text-sm font-semibold text-warning"
        >
          Pertexo can’t tell whether {step} finished
        </h2>
        <p className="mt-1 text-muted-foreground">
          It lost contact while {step} was running. Check the service that step
          talks to before replaying, so its action isn’t repeated.
        </p>
      </div>
    </section>
  );
}
