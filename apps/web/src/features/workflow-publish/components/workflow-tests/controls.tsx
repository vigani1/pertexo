import { Button } from '@/components/ui/button';
import type { WorkflowTests } from '../../hooks/use-workflow-tests';

export function WorkflowTestButton({
  tests,
  className,
}: Readonly<{ tests: WorkflowTests; className?: string }>) {
  if (!tests.enabled) return null;
  return (
    <Button
      className={className}
      variant="outline"
      size="sm"
      disabled={tests.preparing || tests.blocked || tests.start.pending}
      onClick={() => void tests.prepare()}
    >
      Test workflow
    </Button>
  );
}

/** Uncertain starts keep the same request; a fresh preparation needs fresh consent. */
export function WorkflowTestActions({
  tests,
  inputBlocked,
  acknowledged,
  onSubmit,
  onPrepare,
}: Readonly<{
  tests: WorkflowTests;
  inputBlocked: boolean;
  acknowledged: boolean;
  onSubmit: () => void;
  onPrepare: () => void;
}>) {
  const locked = tests.start.pending || tests.start.uncertain;
  return (
    <>
      {(tests.preparationError !== undefined ||
        tests.start.error !== undefined) &&
      !locked ? (
        <Button variant="outline" onClick={onPrepare}>
          Prepare again
        </Button>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          disabled={locked && !tests.start.expired}
          onClick={() => {
            tests.setOpen(false);
          }}
        >
          Close
        </Button>
        {tests.start.uncertain ? (
          <Button
            disabled={tests.start.pending || tests.start.expired}
            onClick={tests.start.retry}
          >
            Retry same test request
          </Button>
        ) : (
          <Button
            disabled={
              tests.preparation === undefined ||
              locked ||
              inputBlocked ||
              (tests.preparation.effectfulSteps.length > 0 && !acknowledged)
            }
            onClick={onSubmit}
          >
            {tests.start.pending ? 'Starting…' : 'Start test'}
          </Button>
        )}
      </div>
    </>
  );
}
