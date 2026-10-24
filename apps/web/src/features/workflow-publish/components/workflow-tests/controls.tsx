import { ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { WorkflowTests } from '../../hooks/use-workflow-tests';

function testBusy(tests: WorkflowTests) {
  return tests.preparing || tests.blocked || tests.start.pending;
}

/**
 * Test workflow, split: the button tests this draft once, and its menu holds
 * Run all tests and Test history, so neither needs a bar of its own.
 */
export function WorkflowTestButton({
  tests,
  className,
}: Readonly<{ tests: WorkflowTests; className?: string }>) {
  if (!tests.enabled) return null;
  return (
    <div className={cn('inline-flex', className)}>
      <Button
        variant="outline"
        size="sm"
        className="rounded-r-none"
        disabled={testBusy(tests)}
        onClick={() => void tests.prepare()}
      >
        Test workflow
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="More test actions"
          className={cn(
            buttonVariants({ variant: 'outline', size: 'icon-sm' }),
            '-ml-px rounded-l-none',
          )}
        >
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <WorkflowTestMenuItems tests={tests} withTest={false} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The test actions as menu items: in the split button's menu, and on phones
 * in the editor's ⋯ menu, where Test workflow joins them.
 */
export function WorkflowTestMenuItems({
  tests,
  withTest = true,
}: Readonly<{ tests: WorkflowTests; withTest?: boolean }>) {
  if (!tests.enabled) return null;
  const suiteActionsBlocked =
    tests.blocked ||
    tests.suites.preparing ||
    tests.suites.start.pending ||
    tests.start.pending;
  return (
    <>
      {withTest ? (
        <DropdownMenuItem
          disabled={testBusy(tests)}
          onClick={() => void tests.prepare()}
        >
          Test workflow
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        disabled={suiteActionsBlocked}
        onClick={() => void tests.suites.prepare()}
      >
        Run all tests
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
  onPrepare,
}: Readonly<{
  tests: WorkflowTests;
  inputBlocked: boolean;
  acknowledged: boolean;
  onSubmit: () => void;
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
          <Button disabled={testStartBlocked} onClick={onSubmit}>
            {tests.start.pending ? 'Starting…' : 'Start test'}
          </Button>
        )}
      </div>
    </>
  );
}
