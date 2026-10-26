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
import { DurationField } from '../fields/duration';

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
          control={{ id: fieldControlId(form.nodeId, 'wait-mode') }}
        />
        <FieldDescription>
          {callback
            ? 'The run pauses here until another service calls this step’s URL.'
            : 'Test runs skip the wait, so you don’t have to sit through it.'}
        </FieldDescription>
      </Field>
      <DurationField
        key={callback ? 'timeout' : 'duration'}
        config={config}
        form={form}
        configKey={callback ? 'timeoutSeconds' : 'durationSeconds'}
        label={callback ? 'Give up after' : 'Wait for'}
        description={
          callback
            ? 'Counted from when the run reaches this step, up to 30 days. Add a failure route to handle a timeout.'
            : 'Up to 30 days.'
        }
        maximumSeconds={WAIT_MAXIMUM_SECONDS}
      />
      {callback ? <CallbackSetup config={config} form={form} /> : null}
    </>
  );
}
