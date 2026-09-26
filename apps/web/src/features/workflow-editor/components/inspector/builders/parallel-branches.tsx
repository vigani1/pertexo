import { MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  lastParallelBranch,
  PARALLEL_BRANCH_IDS,
  PARALLEL_MIN_BRANCHES,
  readParallelBranches,
  withParallelBranchCount,
} from '../../../model/setup-builders';
import { fieldControlId, type NodeFormApi } from '../../../model/node-form';

/**
 * How many branches a Parallel splits into. Each is an output on the canvas;
 * the last one can't be dropped while a step is connected to it, since
 * publishing refuses a connection from a branch that isn't there.
 */
export function ParallelBranches({
  branches,
  connectedPorts,
  form,
}: Readonly<{
  branches: readonly string[];
  connectedPorts: ReadonlySet<string>;
  form: NodeFormApi;
}>) {
  const id = fieldControlId(form.nodeId, 'branches');
  const count = branches.length;
  const last = lastParallelBranch(branches);
  const lastConnected = last !== undefined && connectedPorts.has(last);
  function setCount(next: number) {
    form.commit(
      (node) => ({
        config: withParallelBranchCount(
          node.config,
          readParallelBranches(node.config) ?? branches,
          next,
        ),
      }),
      `${form.nodeId}:config:branches`,
    );
  }
  const first = branches[0];
  return (
    <Field>
      <FieldLabel htmlFor={id}>Branches</FieldLabel>
      <div className="flex items-center gap-1.5">
        <output
          id={id}
          aria-live="polite"
          className="grid h-9 min-w-12 place-items-center rounded-md border border-border bg-black/20 px-3 font-mono text-sm"
        >
          {count}
        </output>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Fewer branches"
          title={
            lastConnected
              ? `A step is connected to ${last}. Disconnect it on the canvas first.`
              : undefined
          }
          disabled={
            !form.editable || count <= PARALLEL_MIN_BRANCHES || lastConnected
          }
          onClick={() => {
            setCount(count - 1);
          }}
        >
          <MinusIcon />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="More branches"
          disabled={!form.editable || count >= PARALLEL_BRANCH_IDS.length}
          onClick={() => {
            setCount(Math.max(PARALLEL_MIN_BRANCHES, count + 1));
          }}
        >
          <PlusIcon />
        </Button>
      </div>
      <FieldDescription>
        {count < PARALLEL_MIN_BRANCHES
          ? 'A Parallel splits into at least two branches.'
          : `Each branch is an output, ${first ?? ''} to ${last ?? ''}. Connect a step to each; they run side by side.`}
        {lastConnected && count > PARALLEL_MIN_BRANCHES
          ? ` To drop ${last}, disconnect its step first.`
          : ''}
      </FieldDescription>
    </Field>
  );
}
