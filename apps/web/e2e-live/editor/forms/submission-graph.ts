import {
  formConfigSchema,
  inputRequestConfigSchema,
} from '@pertexo/workflow-model';
import {
  createWorkflowEdgeFixture,
  createWorkflowNodeFixture,
} from '../../../test/support/fixtures/graph';
export function formSubmissionGraph() {
  const form = formConfigSchema.parse({
    title: 'Send a request',
    instructions: 'Tell us what you need.',
    fields: [
      { id: 'message', name: 'message', label: 'Message', type: 'textarea' },
      { id: 'amount', name: 'amount', label: 'Amount', type: 'number' },
      {
        id: 'channels',
        name: 'channels',
        label: 'Channels',
        type: 'multi_select',
        options: ['Email', 'SMS'],
      },
    ],
  });
  const graph = {
    settings: { maxRunDurationMs: 60000 },
    nodes: [
      {
        ...createWorkflowNodeFixture({
          id: 'form',
          definition: { key: 'core.form', version: 1 },
          position: { x: 0, y: 0 },
        }),
        config: form,
      },
      {
        ...createWorkflowNodeFixture({
          id: 'input',
          definition: { key: 'core.request_input', version: 1 },
          position: { x: 260, y: 0 },
        }),
        config: inputRequestConfigSchema.parse({
          title: 'Complete the request',
          fields: [
            { id: 'answer', name: 'answer', label: 'Answer', type: 'text' },
            {
              id: 'channels',
              name: 'channels',
              label: 'Channels',
              type: 'multi_select',
              options: ['Email', 'SMS'],
              maxSelections: 2,
            },
          ],
        }),
        inputMappings: {
          details: {
            kind: 'expression',
            language: 'jsonata',
            expression:
              '{"amount": nodeOutputs.form.values.amount, "request_message": nodeOutputs.form.values.request_message,"channels": nodeOutputs.form.values.channels}',
          },
          prefill: {
            kind: 'expression',
            language: 'jsonata',
            expression:
              '{"answer": nodeOutputs.form.values.request_message, "channels": nodeOutputs.form.values.channels}',
          },
        },
      },
      {
        ...createWorkflowNodeFixture({
          id: 'finish',
          definition: { key: 'core.terminate', version: 1 },
          position: { x: 520, y: 0 },
        }),
        inputMappings: {
          result: {
            kind: 'node_output',
            nodeId: 'input',
            path: '$.values.answer',
          },
          channels: {
            kind: 'node_output',
            nodeId: 'input',
            path: '$.values.channels',
          },
        },
      },
    ],
    edges: [
      createWorkflowEdgeFixture({ source: 'form', target: 'input' }),
      createWorkflowEdgeFixture({ source: 'input', target: 'finish' }),
    ],
  };
  return graph;
}
