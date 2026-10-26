// Test-only: the real step schemas from the built catalog, as the API serves them.
import { platformBrowserNodeDefinitionCatalog } from '../../../../../../packages/node-catalog/dist/browser-catalog.js';
import {
  nodeDefinitionListResponseSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  findCanvas,
  pressSave,
  toastAction,
} from '../../../support/fixtures/editor-actions';
import {
  api,
  editorHandlers,
  editorPath,
  validHandler,
  workflowApi,
  workspaceId,
} from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';

const { items: definitions } = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions.filter(
    (definition) =>
      [
        'core.form',
        'core.request_input',
        'core.read_file',
        'email.send_notification',
      ].includes(definition.definition.key),
  ),
});

const fileField = (name: string, label: string) => ({
  id: `field-${name}`,
  name,
  label,
  type: 'file',
  accept: ['spreadsheets'],
  maxFiles: 3,
  maxBytes: 5_000_000,
  help: '',
  required: true,
});

const message = {
  toEmail: { kind: 'literal', value: 'owner@example.com' },
  subject: { kind: 'literal', value: 'Stock' },
  text: { kind: 'literal', value: 'Attached.' },
} as const;

function step(
  id: string,
  key: string,
  label: string,
  extra: Partial<WorkflowGraphContract['nodes'][number]> = {},
): WorkflowGraphContract['nodes'][number] {
  return {
    id,
    definition: { key, version: 1 },
    position: { x: 0, y: 80 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    label,
    ...extra,
  };
}

function link(source: string, target: string) {
  return {
    id: `${source}-${target}`,
    source: { nodeId: source, port: 'out' },
    target: { nodeId: target, port: 'in' },
  };
}

/** A Form with a file field starts the run; Read file and Send email follow. */
function formGraph(
  emailMappings: WorkflowGraphContract['nodes'][number]['inputMappings'] = message,
): WorkflowGraphContract {
  return {
    nodes: [
      step('form', 'core.form', 'Stock form', {
        config: {
          title: 'Send stock',
          instructions: '',
          fields: [
            {
              id: 'field-note',
              name: 'note',
              label: 'Note',
              type: 'text',
              help: '',
              required: false,
            },
            fileField('stock', 'Stock sheet'),
          ],
        },
      }),
      step('read', 'core.read_file', 'Read stock'),
      step('email', 'email.send_notification', 'Email stock', {
        inputMappings: emailMappings,
      }),
    ],
    edges: [link('form', 'read'), link('read', 'email')],
    settings: {},
  };
}

/** A Request input asks for receipts mid-run; Read file and Send email follow. */
function requestGraph(): WorkflowGraphContract {
  return {
    nodes: [
      step('start', 'core.form', 'Start', {
        config: {
          title: 'Start',
          instructions: '',
          fields: [
            {
              id: 'field-note',
              name: 'note',
              label: 'Note',
              type: 'text',
              help: '',
              required: true,
            },
          ],
        },
      }),
      step('ask', 'core.request_input', 'Ask for receipts', {
        config: {
          title: 'Receipts needed',
          instructions: '',
          audience: { roles: ['owner'], memberIds: [] },
          fields: [fileField('receipts', 'Receipts')],
        },
      }),
      step('read', 'core.read_file', 'Read receipt'),
      step('email', 'email.send_notification', 'Email receipts', {
        inputMappings: message,
      }),
    ],
    edges: [link('start', 'ask'), link('ask', 'read'), link('ask', 'email')],
    settings: {},
  };
}

async function openInputs(graph: WorkflowGraphContract, stepLabel: string) {
  const saved: { graph?: WorkflowGraphContract } = {};
  mockServer.use(
    ...editorHandlers(
      (_request, body) => {
        saved.graph = body.graph;
      },
      { graph, definitions },
    ),
    validHandler(),
    http.get(`${workflowApi}/comments`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get(`${api}/workspaces/${workspaceId}/variables`, () =>
      HttpResponse.json({ revision: 1, values: {}, descriptions: {} }),
    ),
  );
  renderApp(editorPath);
  const event = userEvent.setup();
  fireEvent.click((await findCanvas()).getByText(stepLabel));
  await event.click(await screen.findByRole('tab', { name: 'Inputs' }));
  const mappingsOf = (nodeId: string) =>
    saved.graph?.nodes.find((node) => node.id === nodeId)?.inputMappings;
  return { event, mappingsOf };
}

describe('form files in later steps', { timeout: 30_000 }, () => {
  it('reads the first file of a form field from the run input', async () => {
    const { event, mappingsOf } = await openInputs(formGraph(), 'Read stock');
    await event.click(screen.getByRole('button', { name: 'Insert data' }));
    expect(
      screen.queryByRole('button', { name: /first file from Note/u }),
    ).toBeNull();
    await event.click(
      await screen.findByRole('button', {
        name: /^first file from Stock sheet/u,
      }),
    );
    pressSave();
    await waitFor(() => {
      expect(mappingsOf('read')).toEqual({
        file: { kind: 'run_input', path: '$.values.stock[0].file' },
      });
    });
  });

  it('attaches every file of a form field, names included', async () => {
    const { event, mappingsOf } = await openInputs(formGraph(), 'Email stock');
    const section = screen.getByRole('region', { name: 'Attachments' });
    await event.click(
      within(section).getByRole('button', { name: 'Attach a file' }),
    );
    expect(
      screen.queryByRole('button', { name: 'file from the run input' }),
    ).toBeNull();
    await event.click(
      await screen.findByRole('button', {
        name: 'all files from Stock sheet',
      }),
    );
    expect(
      within(section).getByText(/These attachments come from one list/u),
    ).toBeVisible();
    pressSave();
    await waitFor(() => {
      expect(mappingsOf('email')).toEqual({
        ...message,
        attachments: { kind: 'run_input', path: '$.values.stock' },
      });
    });
  });

  it('replaces files attached one by one and offers Undo', async () => {
    const uploaded = {
      kind: 'literal',
      value: [
        {
          file: {
            kind: 'artifact',
            artifactId: 'abababab-abab-4bab-8bab-abababababab',
            byteLength: 10,
            mediaType: 'application/pdf',
            sha256: 'a'.repeat(64),
          },
          filename: 'Terms.pdf',
        },
      ],
    } as const;
    const { event, mappingsOf } = await openInputs(
      formGraph({ ...message, attachments: uploaded }),
      'Email stock',
    );
    const section = screen.getByRole('region', { name: 'Attachments' });
    await event.click(
      within(section).getByRole('button', { name: 'Attach a file' }),
    );
    await event.click(
      await screen.findByRole('button', {
        name: 'all files from Stock sheet',
      }),
    );
    expect(within(section).queryByText('Terms')).toBeNull();
    await event.click(toastAction('Undo'));
    expect(within(section).getByText('Terms')).toBeVisible();
    pressSave();
    await waitFor(() => {
      expect(mappingsOf('email')).toEqual({
        ...message,
        attachments: uploaded,
      });
    });
  });

  it('offers a Request input’s files from its output', async () => {
    const { event, mappingsOf } = await openInputs(
      requestGraph(),
      'Email receipts',
    );
    const section = screen.getByRole('region', { name: 'Attachments' });
    await event.click(
      within(section).getByRole('button', { name: 'Attach a file' }),
    );
    // A form without file fields still starts this run, so $.file isn't offered.
    expect(
      screen.queryByRole('button', { name: 'file from the run input' }),
    ).toBeNull();
    await event.click(
      await screen.findByRole('button', { name: 'all files from Receipts' }),
    );
    pressSave();
    await waitFor(() => {
      expect(mappingsOf('email')).toEqual({
        ...message,
        attachments: {
          kind: 'node_output',
          nodeId: 'ask',
          path: '$.values.receipts',
        },
      });
    });
  });

  it('reads the first file a Request input received', async () => {
    const { event, mappingsOf } = await openInputs(
      requestGraph(),
      'Read receipt',
    );
    await event.click(screen.getByRole('button', { name: 'Insert data' }));
    await event.click(
      await screen.findByRole('button', { name: /^first file from Receipts/u }),
    );
    pressSave();
    await waitFor(() => {
      expect(mappingsOf('read')).toEqual({
        file: {
          kind: 'node_output',
          nodeId: 'ask',
          path: '$.values.receipts[0].file',
        },
      });
    });
  });
});
