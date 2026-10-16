import type { NodeConfig } from '../../../model/inspector/draft';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { SchemaField } from '../fields/schema-field';

export function WebhookTriggerSetup({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const mode = config.responseMode ?? 'immediate';
  return (
    <>
      <SchemaField
        config={{ ...config, responseMode: mode }}
        form={form}
        field={{
          key: 'responseMode',
          label: 'Respond to caller',
          kind: 'string',
          required: true,
          options: ['immediate', 'workflow'],
          optionLabels: {
            immediate: 'Immediately (202)',
            workflow: 'When the workflow responds',
          },
          description:
            'Execution always runs on the worker. A caller disconnecting never cancels the run.',
        }}
      />
      {mode === 'workflow' ? (
        <SchemaField
          config={{
            ...config,
            responseWaitSeconds: config.responseWaitSeconds ?? 10,
          }}
          form={form}
          field={{
            key: 'responseWaitSeconds',
            label: 'Wait time (seconds)',
            kind: 'integer',
            required: true,
            minimum: 1,
            maximum: 30,
            description:
              'Add a Respond to webhook step. After this wait, the caller gets 202 with the run ID and execution continues.',
          }}
        />
      ) : null}
    </>
  );
}
