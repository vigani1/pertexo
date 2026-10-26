import {
  nodeDefinitionListResponseSchema,
  type NodeDefinitionCatalogItem,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { EMAIL_SEND_NOTIFICATION_MANIFEST } from '@pertexo/integrations';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  findCanvas,
  pressSave,
} from '../../../support/fixtures/editor-actions';
import {
  editorHandlers,
  editorPath,
  setDefinition,
} from '../../../support/fixtures/workflow-editor';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';

const createFileDefinition = {
  ...setDefinition,
  definition: { key: 'core.create_file', version: 1 },
  outputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'object',
        properties: { kind: { type: 'string', const: 'artifact' } },
      },
    },
  },
} satisfies NodeDefinitionCatalogItem;

// The real step schemas, read through the catalog contract as the API serves them.
const [emailDefinition] = nodeDefinitionListResponseSchema.parse({
  items: [
    {
      ...setDefinition,
      definition: { key: 'email.send_notification', version: 1 },
      family: 'action',
      configSchema: { type: 'object', properties: {} },
      inputSchema: EMAIL_SEND_NOTIFICATION_MANIFEST.inputSchema,
      outputSchema: EMAIL_SEND_NOTIFICATION_MANIFEST.outputSchema,
    },
  ],
}).items;

const message = {
  toEmail: { kind: 'literal', value: 'owner@example.com' },
  subject: { kind: 'literal', value: 'Weekly report' },
  text: { kind: 'literal', value: 'Attached.' },
} as const;

function uploaded(byteLength: number) {
  return {
    kind: 'artifact',
    artifactId: 'abababab-abab-4bab-8bab-abababababab',
    byteLength,
    mediaType: 'application/pdf',
    sha256: 'a'.repeat(64),
  };
}

function reportGraph(
  inputMappings: WorkflowGraphContract['nodes'][number]['inputMappings'] = message,
): WorkflowGraphContract {
  return {
    nodes: [
      {
        id: 'create',
        definition: { key: 'core.create_file', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
        label: 'Weekly report',
      },
      {
        id: 'email',
        definition: { key: 'email.send_notification', version: 1 },
        position: { x: 340, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings,
        connectionRefs: {},
        label: 'Email it',
      },
    ],
    edges: [
      {
        id: 'create-email',
        source: { nodeId: 'create', port: 'out' },
        target: { nodeId: 'email', port: 'in' },
      },
    ],
    settings: {},
  };
}

async function openAttachments(graph: WorkflowGraphContract) {
  const saved: { graph?: WorkflowGraphContract } = {};
  mockServer.use(
    ...editorHandlers(
      (_request, body) => {
        saved.graph = body.graph;
      },
      {
        graph,
        definitions: [
          createFileDefinition,
          ...(emailDefinition === undefined ? [] : [emailDefinition]),
        ],
      },
    ),
  );
  renderApp(editorPath);
  const event = userEvent.setup();
  fireEvent.click((await findCanvas()).getByText('Email it'));
  await event.click(await screen.findByRole('tab', { name: 'Inputs' }));
  return {
    event,
    saved,
    section: screen.getByRole('region', { name: 'Attachments' }),
  };
}

describe('Send email attachments', { timeout: 30_000 }, () => {
  it('attaches a file from an earlier step, renames it and keeps the message rows apart', async () => {
    const { event, saved, section } = await openAttachments(reportGraph());
    expect(
      within(section).getByText('Attach a file from an earlier step'),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Inputs' })).queryByRole(
        'button',
        { name: /^attachments/u },
      ),
    ).toBeNull();

    await event.click(
      within(section).getByRole('button', { name: 'Attach a file' }),
    );
    await event.click(
      await screen.findByRole('button', { name: 'file from Weekly report' }),
    );
    expect(
      within(section).getByText('Named from its type when sent'),
    ).toBeVisible();
    expect(
      within(section).getByText('from Weekly report › file'),
    ).toBeVisible();
    expect(
      within(section).getByRole('meter', { name: 'Attachment size' }),
    ).toHaveAttribute(
      'aria-valuetext',
      '1 file · 0 B of 6 MB · 1 measured when sent',
    );

    await event.click(
      within(section).getByRole('button', { name: 'Edit attachment 1' }),
    );
    await event.type(
      within(section).getByRole('textbox', { name: 'Name in the email' }),
      'week-42.csv',
    );
    pressSave();
    await waitFor(() => {
      expect(saved.graph?.nodes[1]?.inputMappings).toEqual({
        ...message,
        attachments: {
          kind: 'expression',
          language: 'jsonata',
          expression:
            '[\n  {"file": (nodeOutputs."create"."file"), "filename": "week-42.csv"}\n]',
        },
      });
    });
    expect(within(section).getByText('week-42')).toBeVisible();
  });

  it('shows uploaded files with their sizes and warns when they exceed the limit', async () => {
    const { event, saved, section } = await openAttachments(
      reportGraph({
        ...message,
        attachments: {
          kind: 'literal',
          value: [
            { file: uploaded(4_823_449), filename: 'Price list.pdf' },
            { file: uploaded(2_097_152) },
          ],
        },
      }),
    );
    expect(within(section).getByText('Price list')).toBeVisible();
    expect(within(section).getByText('attachment-2')).toBeVisible();
    expect(within(section).getByText('2 / 10')).toBeVisible();
    expect(
      within(section).getByText(/over the limit for one email/u),
    ).toBeVisible();

    await event.click(
      within(section).getByRole('button', { name: 'Remove attachment-2.pdf' }),
    );
    expect(within(section).queryByText(/over the limit/u)).toBeNull();
    await event.click(
      within(section).getByRole('button', { name: 'Remove Price list.pdf' }),
    );
    expect(
      within(section).getByText('Attach a file from an earlier step'),
    ).toBeVisible();
    pressSave();
    await waitFor(() => {
      expect(saved.graph?.nodes[1]?.inputMappings).toEqual(message);
    });
  });

  it('keeps the attachments when a message row changes', async () => {
    const attachments = {
      kind: 'literal',
      value: [{ file: uploaded(10) }],
    } as const;
    const { event, saved } = await openAttachments(
      reportGraph({ ...message, attachments }),
    );
    const inputs = screen.getByRole('region', { name: 'Inputs' });
    await event.click(
      within(inputs).getByRole('button', { name: /^subject from/u }),
    );
    const value = within(inputs).getByLabelText('Value');
    await event.clear(value);
    await event.type(value, 'Week 42');
    pressSave();
    await waitFor(() => {
      expect(saved.graph?.nodes[1]?.inputMappings).toEqual({
        ...message,
        subject: { kind: 'literal', value: 'Week 42' },
        attachments,
      });
    });
  });
});
