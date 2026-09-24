import { Notice } from '@/components/ui/notice';

/**
 * An unknown outcome isn't a failure: Pertexo lost contact mid-step. Say so
 * plainly and warn before a replay repeats a side effect.
 */
export function OutcomeUnknownCard({
  stepLabel,
}: Readonly<{ stepLabel: string | undefined }>) {
  const step = stepLabel ?? 'a step';
  return (
    <Notice
      tone="warning"
      role="region"
      aria-labelledby="outcome-unknown-title"
      title={
        <h2 id="outcome-unknown-title" className="text-sm font-semibold">
          Pertexo can’t tell whether {step} finished
        </h2>
      }
    >
      It lost contact while {step} was running. Check the service that step
      talks to before replaying, so its action isn’t repeated.
    </Notice>
  );
}
