import { useMemo } from 'react';
import { supportsStepRetrySettings } from '@pertexo/workflow-model';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { Disclosure } from '@/components/ui/disclosure';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { ChoiceSelect } from '../fields/choice-select';
import { SchemaField } from '../fields/schema';
import { useScratchForm } from '../use-draft-field';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import {
  describeStepRetrySettings,
  retryFields,
  retryModes,
  retryPolicyLabels,
  retrySettingsForMode,
  shownRetrySettings,
  stepRetryForm,
  stepRetryMode,
} from '../../../model/inspector/retries/draft';

type Props = Readonly<{
  node: WorkflowGraphContract['nodes'][number];
  form: NodeFormApi;
}>;

export function StepRetrySetup({ node, form }: Props) {
  if (!supportsStepRetrySettings(node.definition))
    return node.retry === undefined ? null : (
      <div className="mt-4 flex flex-col items-start gap-2 text-sm">
        <p>
          Retry settings apply to action steps, not triggers or workflow
          controls.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={!form.editable}
          onClick={() => {
            form.commit({ retry: undefined }, `${form.nodeId}:retry:mode`);
          }}
        >
          Remove retry override
        </Button>
      </div>
    );
  return <ActionRetries node={node} form={form} />;
}

function ActionRetries({ node, form }: Props) {
  const { form: trackedForm, hasScratch } = useScratchForm(form);
  const fieldsForm = useMemo(() => stepRetryForm(trackedForm), [trackedForm]);
  const mode = stepRetryMode(node.retry);
  const label = retryPolicyLabels[mode];
  const id = fieldControlId(form.nodeId, 'retry-mode');
  const helpId = `${id}-help`;
  return (
    <Disclosure
      summary={`Retries · ${label}`}
      className="mt-4 border-t border-border pt-3"
      contentClassName="flex flex-col gap-4"
      appearance={{ tone: 'strong' }}
    >
      <Field>
        <FieldLabel htmlFor={id}>Retry policy</FieldLabel>
        <ChoiceSelect
          value={mode}
          choices={retryModes}
          disabled={!form.editable || hasScratch}
          onChange={(next) => {
            if (next !== null)
              form.commit(
                (current) => ({ retry: retrySettingsForMode(next, current) }),
                `${form.nodeId}:retry:mode`,
              );
          }}
          control={{ id, describedBy: helpId }}
        />
        <FieldDescription id={helpId}>
          {describeStepRetrySettings(node.retry)}{' '}
          {hasScratch
            ? 'Finish incomplete fields before changing the policy.'
            : null}
        </FieldDescription>
      </Field>
      {mode === 'custom'
        ? retryFields.map((field) => (
            <SchemaField
              key={field.key}
              field={field}
              config={shownRetrySettings(node)}
              form={fieldsForm}
            />
          ))
        : null}
      <p className="text-xs text-subtle-foreground">
        Unknown outcomes are never retried automatically. Deadlines and
        cancellation still apply. Runs and Test workflow use this policy; Test
        step makes one attempt.
      </p>
    </Disclosure>
  );
}
