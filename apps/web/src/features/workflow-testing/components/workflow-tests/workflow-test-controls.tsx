import type { ReactNode } from 'react';
import { ChevronDownIcon, PlayIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/class-names';
import type { WorkflowTests } from '../../data/workflow-tests/workflow-tests.mutations';

function testBusy(tests: WorkflowTests) {
  return tests.preparing || tests.blocked || tests.start.pending;
}

/**
 * Test the current draft, or open all the ways to test and run this workflow.
 */
export function WorkflowTestButton({
  tests,
  runItems = null,
}: Readonly<{ tests: WorkflowTests; runItems?: ReactNode }>) {
  if (!tests.enabled && runItems === null) return null;
  return (
    <div className="inline-flex">
      {!tests.enabled ? null : (
        <Button
          variant="outline"
          size="sm"
          className="rounded-r-none"
          disabled={testBusy(tests)}
          aria-label="Test workflow"
          onClick={() => void tests.prepare()}
        >
          <PlayIcon aria-hidden="true" />
          Test
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Test and run actions"
          className={
            tests.enabled
              ? cn(
                  buttonVariants({ variant: 'outline', size: 'icon-sm' }),
                  '-ml-px rounded-l-none',
                )
              : buttonVariants({ variant: 'outline', size: 'sm' })
          }
        >
          {tests.enabled ? null : 'Run'}
          <ChevronDownIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {tests.enabled ? <WorkflowTestMenuItems tests={tests} /> : null}
          {runItems}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function WorkflowTestMenuItems({ tests }: Readonly<{ tests: WorkflowTests }>) {
  const suiteActionsBlocked =
    tests.blocked ||
    tests.suites.preparing ||
    tests.suites.start.pending ||
    tests.start.pending;
  return (
    <>
      <DropdownMenuItem
        disabled={suiteActionsBlocked}
        onClick={() => void tests.suites.prepare()}
      >
        Run all tests
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={suiteActionsBlocked}
        onClick={() => void tests.suites.prepare('table')}
      >
        Evaluate data table
      </DropdownMenuItem>
      <DropdownMenuItem onClick={tests.showHistory}>
        Test history
      </DropdownMenuItem>
    </>
  );
}

/** Uncertain starts keep the same request; a fresh preparation needs fresh consent. */
export function WorkflowTestActions({
  tests,
  inputBlocked,
  acknowledged,
  onSubmit,
  onClose,
  onPrepare,
}: Readonly<{
  tests: WorkflowTests;
  inputBlocked: boolean;
  acknowledged: boolean;
  onSubmit: () => void;
  onClose: () => void;
  onPrepare: () => void;
}>) {
  const locked = tests.start.pending || tests.start.uncertain;
  const testStartBlocked =
    tests.preparation === undefined ||
    locked ||
    inputBlocked ||
    (tests.preparation.effectfulSteps.length > 0 && !acknowledged);
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
          onClick={onClose}
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
          <Button disabled={testStartBlocked} onClick={onSubmit}>
            {tests.start.pending ? 'Starting…' : 'Start test'}
          </Button>
        )}
      </div>
    </>
  );
}
