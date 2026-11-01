import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { ChevronRightIcon } from 'lucide-react';
import { use, useId, useState, type ReactNode } from 'react';
import { describeStep, StepTile } from '@/features/catalog/presentation.public';
import {
  useStepOutputSample,
  type StepOutputSample,
} from '@/features/workflow-publish/step-samples.public';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { StepTestOutputsContext } from '../../../../hooks/use-last-test';
import { findDefinition, stepTitle } from '../../../../model/graph/adapter';
import type { WorkflowNode } from '../../../../model/graph/scopes';
import { useEditorSession } from '../../../../model/state/context';
import {
  declaredStepFields,
  fieldTree,
} from '../../../../model/inspector/input-mappings/fields';
import { FieldList, type FieldPick } from './field-tree';

const SAMPLE_ORIGIN: Readonly<
  Record<Extract<StepOutputSample, { kind: 'value' }>['from'], string>
> = {
  pin: 'Values from its pinned sample',
  step_test: 'Values from your last test',
  workflow_test: 'Values from the latest workflow test',
  run: 'Values from its latest run',
};

/**
 * One source of data: what a step declares joined with what it really
 * returned. It reads that output only once open, and always says what to do
 * when there's none yet.
 */
export function StepFields({
  step,
  title,
  wholeLabel,
  startOpen,
  definitions,
  onPick,
  children,
}: Readonly<{
  step: WorkflowNode;
  title?: string;
  wholeLabel?: string;
  startOpen: boolean;
  definitions: readonly NodeDefinitionCatalogItem[];
  onPick: FieldPick;
  children?: ReactNode;
}>) {
  const { scope, editing } = useEditorSession();
  const { apiClient, userId, workspace, workflowId } = scope;
  const [open, setOpen] = useState(startOpen);
  const [asked, setAsked] = useState(false);
  const fieldsId = useId();
  const canRead = workspace.capabilities.includes('run:read');
  const stepTest = use(StepTestOutputsContext).get(step.id);
  const sample = useStepOutputSample({
    scope: { apiClient, userId, workspaceId: workspace.id, workflowId },
    nodeId: step.id,
    stepTest,
    enabled: open && canRead,
  });
  const definition = findDefinition(definitions, step);
  const name = stepTitle(step);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={fieldsId}
        className="flex min-h-7 w-full items-center gap-2 rounded-sm text-left text-[0.8rem] font-semibold outline-none hover:bg-surface-ink/5 focus-ring pointer-coarse:min-h-10"
        onClick={() => {
          setAsked(true);
          setOpen((current) => !current);
        }}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn('size-3.5 shrink-0', open && 'rotate-90')}
        />
        <StepTile
          step={describeStep(step.definition.key, definition?.family)}
          size="sm"
        />
        <span className="min-w-0 truncate">{title ?? name}</span>
      </button>
      {open ? (
        <div
          id={fieldsId}
          // A section opened at the list's end would otherwise open out of sight.
          ref={
            asked
              ? (element) => element?.scrollIntoView({ block: 'nearest' })
              : undefined
          }
        >
          <SampleStatus
            sample={sample}
            canRead={canRead}
            stepName={name}
            onTest={() => {
              editing.actions.navigation.showTestOutput(step.id);
            }}
          />
          <FieldList
            {...(wholeLabel === undefined ? {} : { wholeLabel })}
            {...fieldTree(
              declaredStepFields(step, definition),
              sample.kind === 'value' ? { value: sample.value } : undefined,
            )}
            onPick={onPick}
          >
            {children}
          </FieldList>
        </div>
      ) : null}
    </li>
  );
}

/** One line, in place from the start, so the fields below it never jump. */
function SampleStatus({
  sample,
  canRead,
  stepName,
  onTest,
}: Readonly<{
  sample: StepOutputSample;
  canRead: boolean;
  stepName: string;
  onTest: () => void;
}>) {
  const className =
    'mt-1 ml-3 flex min-h-7 flex-wrap items-center gap-x-2 text-xs text-subtle-foreground';
  if (!canRead)
    return (
      <p className={className}>
        You can’t read run data here, so only its declared fields show.
      </p>
    );
  switch (sample.kind) {
    case 'loading':
      return <p className={className}>Looking for its last output…</p>;
    case 'value':
      return <p className={className}>{SAMPLE_ORIGIN[sample.from]}</p>;
    case 'file':
      return (
        <p className={className}>
          Its last output is stored as a file, so it has no fields to list.
        </p>
      );
    case 'failed':
      return (
        <p className={className}>
          Couldn’t load its last output.
          <Button type="button" variant="link" size="sm" onClick={sample.retry}>
            Try again
          </Button>
        </p>
      );
    case 'none':
      return (
        <p className={className}>
          No test data yet.
          <Button type="button" variant="link" size="sm" onClick={onTest}>
            Test {stepName} to see its fields
          </Button>
        </p>
      );
  }
}
