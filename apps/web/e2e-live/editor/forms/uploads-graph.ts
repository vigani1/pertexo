import {
  formConfigSchema,
  inputRequestConfigSchema,
} from '@pertexo/workflow-model';
import {
  createWorkflowEdgeFixture,
  createWorkflowNodeFixture,
} from '../../../test/support/fixtures/graph';

/** Form with a CSV upload → Read file → Request input for a signed PDF → finish. */
export function formUploadsGraph() {
  const node = (id: string, key: string, x: number) =>
    createWorkflowNodeFixture({
      id,
      definition: { key, version: 1 },
      position: { x, y: 0 },
    });
  return {
    settings: { maxRunDurationMs: 120000 },
    nodes: [
      {
        ...node('form', 'core.form', 0),
        config: formConfigSchema.parse({
          title: 'Send this month’s orders',
          instructions: 'Attach the orders export from your shop.',
          fields: [
            { id: 'shop', name: 'shop', label: 'Shop', type: 'text' },
            {
              id: 'orders',
              name: 'orders',
              label: 'Orders export',
              type: 'file',
              accept: ['spreadsheets'],
              maxBytes: 1_048_576,
            },
          ],
        }),
      },
      {
        ...node('read', 'core.read_file', 260),
        config: { format: 'csv', delimiter: ',', convertValues: true },
        inputMappings: {
          file: {
            kind: 'node_output',
            nodeId: 'form',
            path: '$.values.orders[0].file',
          },
        },
      },
      {
        ...node('note', 'core.request_input', 520),
        config: inputRequestConfigSchema.parse({
          title: 'Upload the signed delivery note',
          fields: [
            {
              id: 'signed',
              name: 'signed',
              label: 'Signed delivery note',
              type: 'file',
              accept: ['documents'],
            },
          ],
        }),
      },
      {
        ...node('finish', 'core.terminate', 780),
        inputMappings: {
          signed: {
            kind: 'node_output',
            nodeId: 'note',
            path: '$.values.signed',
          },
        },
      },
    ],
    edges: [
      createWorkflowEdgeFixture({ source: 'form', target: 'read' }),
      createWorkflowEdgeFixture({ source: 'read', target: 'note' }),
      createWorkflowEdgeFixture({ source: 'note', target: 'finish' }),
    ],
  };
}
