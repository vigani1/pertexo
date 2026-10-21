import { CallbackSetup } from './callback';
import {
  callbackWaitConfigSchema,
  WAIT_MAXIMUM_SECONDS,
} from '@pertexo/workflow-model';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import type { NodeConfig } from '../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { ChoiceSelect } from '../fields/choice-select';
import { SchemaField } from '../fields/schema-field';

export function WaitSetup({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const callback = config.mode === 'callback';
  return (
    <>
      <Field>
        <FieldLabel htmlFor={fieldControlId(form.nodeId, 'wait-mode')}>
          Wait until
        </FieldLabel>
        <ChoiceSelect
          id={fieldControlId(form.nodeId, 'wait-mode')}
          value={callback ? 'callback' : 'duration'}
          disabled={!form.editable}
          choices={[
            { value: 'duration', label: 'A duration has passed' },
            { value: 'callback', label: 'Called back' },
          ]}
          onChange={(mode) => {
            if (mode === null || (mode === 'callback') === callback) return;
            form.commit(
              {
                config:
                  mode === 'callback'
                    ? callbackWaitConfigSchema.parse({
                        mode: 'callback',
                        timeoutSeconds: 3600,
                      })
                    : { durationSeconds: 60 },
              },
              `${form.nodeId}:wait-mode`,
            );
          }}
        />
        <FieldDescription>
          {callback
            ? 'An earlier sending step can insert this Wait’s callback URL. The first authenticated POST resumes this run once.'
            : 'Pause for a fixed duration. Draft workflow tests complete duration waits immediately.'}
        </FieldDescription>
      </Field>
      <SchemaField
        config={config}
        form={form}
        field={{
          key: callback ? 'timeoutSeconds' : 'durationSeconds',
          label: callback
            ? 'Callback timeout (seconds)'
            : 'Wait for (in seconds)',
          kind: 'integer',
          required: true,
          minimum: 1,
          maximum: WAIT_MAXIMUM_SECONDS,
          description: callback
            ? 'From 1 second to 30 days, starting when this step opens. A timeout fails the step; add a failure route to handle it.'
            : 'From 1 second to 30 days.',
        }}
      />
      {callback ? <CallbackSetup config={config} form={form} /> : null}
    </>
  );
}
