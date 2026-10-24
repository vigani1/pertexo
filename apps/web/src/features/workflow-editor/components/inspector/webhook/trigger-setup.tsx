import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import { EventCoordinationSetup } from '../event-coordination/setup';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { SchemaField } from '../fields/schema';

export function WebhookTriggerSetup({
  node,
  graph,
  form,
}: Readonly<{ node: WorkflowNode; graph: GraphLevel; form: NodeFormApi }>) {
  const config = node.config;
  const mode = config.responseMode ?? 'immediate';
  return (
    <>
      <SchemaField
        config={{ ...config, runInput: config.runInput ?? 'body' }}
        form={form}
        field={{
          key: 'runInput',
          label: 'Run input',
          kind: 'string',
          required: true,
          options: ['body', 'request'],
          optionLabels: {
            body: 'Data sent',
            request: 'Full request',
          },
          description:
            'Data sent is a POST body, or the query of a GET. Full request adds the method, query and headers, without credentials, signatures, cookies or proxy headers.',
        }}
      />
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
      <EventCoordinationSetup node={node} graph={graph} form={form} />
    </>
  );
}
