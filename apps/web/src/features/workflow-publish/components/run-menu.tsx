import { ChevronDownIcon, PlayIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LoadingOrb } from '@/components/ui/loading-orb';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * Run ▾: start the published version straight away, or with an input. With
 * nothing published there is nothing to run, and the control says why.
 */
export function RunMenu({
  published,
  pending,
  acceptedRunPending,
  onRunNow,
  onRunWithInput,
  onOpenAcceptedRun,
}: Readonly<{
  published: boolean;
  pending: boolean;
  /** A run was accepted while the editor was paused; open it explicitly. */
  acceptedRunPending: boolean;
  onRunNow: () => void;
  onRunWithInput: () => void;
  onOpenAcceptedRun: () => void;
}>) {
  if (acceptedRunPending)
    return (
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={onOpenAcceptedRun}
      >
        {pending ? 'Verifying…' : 'Open accepted run'}
      </Button>
    );
  if (!published)
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled
              focusableWhenDisabled
              aria-label="Run (publish first)"
            />
          }
        >
          <PlayIcon data-icon="inline-start" />
          Run
        </TooltipTrigger>
        <TooltipContent>Publish first</TooltipContent>
      </Tooltip>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        {pending ? <LoadingOrb /> : <PlayIcon data-icon="inline-start" />}
        {pending ? 'Starting…' : 'Run'}
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onRunNow}>
            Run published version
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRunWithInput}>
            Run with input…
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
