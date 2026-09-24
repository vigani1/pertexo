import { StatusGlyph, type StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';

export type MigrationStep = 'choose' | 'confirm' | 'done';

const STEPS: readonly Readonly<{
  step: MigrationStep;
  title: string;
  detail: string;
}>[] = [
  {
    step: 'choose',
    title: 'Choose your new sign-in',
    detail: 'Pick the provider you’ll use from now on.',
  },
  {
    step: 'confirm',
    title: 'Confirm your old account',
    detail: 'Sign in once with the account you used before.',
  },
  {
    step: 'done',
    title: 'Done',
    detail: 'You land in your workspaces with the new sign-in.',
  },
];

function toneFor(index: number, currentIndex: number): StatusTone {
  if (index < currentIndex) return 'success';
  if (index === currentIndex && STEPS[index]?.step === 'confirm')
    return 'waiting';
  return 'neutral';
}

/** The three-step path, one sentence each, current step emphasised. */
export function MigrationSteps({
  current,
}: Readonly<{ current: MigrationStep }>) {
  const currentIndex = STEPS.findIndex((item) => item.step === current);
  return (
    <ol aria-label="Steps" className="mt-6 flex flex-col gap-3">
      {STEPS.map((item, index) => {
        const tone = toneFor(index, currentIndex);
        return (
          <li
            key={item.step}
            aria-current={index === currentIndex ? 'step' : undefined}
            className={cn(
              'grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 gap-y-0.5',
              index > currentIndex && 'opacity-55',
            )}
          >
            <StatusGlyph
              tone={tone}
              className={cn(
                'mt-0.5',
                tone === 'success' && 'text-success',
                tone === 'waiting' && 'text-secondary',
                tone === 'neutral' &&
                  (index === currentIndex
                    ? 'text-accent-foreground'
                    : 'text-subtle-foreground'),
              )}
            />
            <span className="text-[0.85rem] font-semibold">
              <span className="sr-only">
                Step {index + 1}
                {index < currentIndex ? ', done' : ''}:{' '}
              </span>
              {item.title}
            </span>
            <span className="col-start-2 text-[0.8rem] text-muted-foreground">
              {item.detail}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
