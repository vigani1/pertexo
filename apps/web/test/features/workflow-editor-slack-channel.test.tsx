import { HttpResponse, http } from 'msw';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { parseChannelId } from '@/features/workflow-editor/model/slack-channel';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import { slackChannelLookup, slackConnection } from '../support/slack-channels';
import {
  api,
  editorHandlers,
  editorPath,
  findCanvas,
  pressSave,
  setDefinition,
  workspace,
  workspaceId,
} from '../support/workflow-editor-fixtures';

type InputMappings = WorkflowGraphContract['nodes'][number]['inputMappings'];

const connectionId = '44444444-4444-4444-8444-444444444444';
const workspaceApi = `${api}/workspaces/${workspaceId}`;

const slackDefinition = {
  ...setDefinition,
  definition: { key: 'slack.send_message', version: 1 },
  family: 'action',
  configSchema: {
    type: 'object',
    properties: { timeoutMillis: { type: 'integer', title: 'Timeout' } },
  },
  connectionRequirements: ['slack_bot_token'],
  credentialRequirements: ['slack_bot_token'],
} satisfies NodeDefinitionCatalogItem;

function slackGraph(
  inputMappings: InputMappings,
  connectionRefs: Readonly<Record<string, string>> = {
    slack_bot_token: connectionId,
  },
): WorkflowGraphContract {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'post',
        label: 'Tell ops',
        definition: { key: 'slack.send_message', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {},
        inputMappings,
        connectionRefs,
      },
    ],
    edges: [],
    settings: {},
  };
}

async function openSlackStep(
  graph: WorkflowGraphContract,
  capabilities: readonly string[] = [
    ...workspace.capabilities,
    'connection:use',
  ],
) {
  const saved: { graph?: WorkflowGraphContract } = {};
  const lookups: string[] = [];
  mockServer.use(
    ...editorHandlers(
      (_request, body) => {
        saved.graph = body.graph;
      },
      { graph, definitions: [slackDefinition], capabilities },
    ),
    http.get(`${workspaceApi}/connections`, () =>
      HttpResponse.json({
        items: [slackConnection(workspaceId, connectionId)],
        nextCursor: null,
      }),
    ),
    slackChannelLookup(
      workspaceApi,
      {
        C0123456789: { name: 'ops-alerts' },
        C0404: { reason: 'missing_scope' },
      },
      lookups,
    ),
  );
  renderApp(editorPath);
  fireEvent.click((await findCanvas()).getByText('Tell ops'));
  const field = await screen.findByLabelText('Channel ID');
  return { field, saved, lookups, event: userEvent.setup() };
}

describe('Slack channel IDs as people type them', () => {
  it('accepts channel IDs, with or without #, and clears on empty', () => {
    expect(parseChannelId(' #C0123ABC ')).toEqual({
      ok: true,
      value: 'C0123ABC',
    });
    expect(parseChannelId('')).toEqual({ ok: true, value: undefined });
    expect(parseChannelId('ops-alerts')).toMatchObject({ ok: false });
  });
});

describe('the Slack step’s channel in Setup', { timeout: 30_000 }, () => {
  it('shows the channel’s name beside its ID once it resolves', async () => {
    const { field, lookups } = await openSlackStep(
      slackGraph({ channelId: { kind: 'literal', value: 'C0123456789' } }),
    );
    expect(field).toHaveValue('C0123456789');
    const name = document.getElementById(`${field.id}-name`);
    await waitFor(() => {
      expect(name).toHaveTextContent('#ops-alerts');
    });
    expect(field).toHaveAccessibleDescription(/#ops-alerts/u);
    expect(lookups).toEqual(['C0123456789']);
  });

  it('applies a typed ID, looks it up after the field is left, and says why a name is missing', async () => {
    const { field, saved, lookups, event } = await openSlackStep(
      slackGraph({ channelId: { kind: 'literal', value: 'C0123456789' } }),
    );
    await event.clear(field);
    await event.type(field, 'ops');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Channel IDs start with C, G or D/u,
    );
    await event.clear(field);
    await event.type(field, '#C0404');
    await event.tab();
    expect(
      await screen.findByText(
        /Showing the channel ID\. The Slack app needs the channels:read scope/u,
      ),
    ).toBeVisible();
    // Nothing was looked up while typing.
    expect(lookups.filter((ids) => ids !== 'C0123456789')).toEqual(['C0404']);
    pressSave();
    await waitFor(() => {
      expect(saved.graph?.nodes[0]?.inputMappings).toEqual({
        channelId: { kind: 'literal', value: 'C0404' },
      });
    });
  });

  it('asks for a connection before it can show a name', async () => {
    const { lookups } = await openSlackStep(
      slackGraph({ channelId: { kind: 'literal', value: 'C0123456789' } }, {}),
    );
    expect(
      screen.getByText(
        'Choose a Slack connection above to show this channel’s name.',
      ),
    ).toBeVisible();
    expect(lookups).toEqual([]);
  });

  it('adds a Slack connection in place and comes back with it selected', async () => {
    const createdId = '55555555-5555-4555-8555-555555555555';
    const created = slackConnection(
      workspaceId,
      createdId,
      'Control Operations Slack',
    );
    const { saved, event } = await openSlackStep(
      slackGraph({ channelId: { kind: 'literal', value: 'C0123456789' } }, {}),
      [...workspace.capabilities, 'connection:use', 'connection:manage'],
    );
    mockServer.use(
      http.post(`${workspaceApi}/connections`, () =>
        HttpResponse.json(created, { status: 201 }),
      ),
      http.post(`${workspaceApi}/connections/${createdId}/test`, () =>
        HttpResponse.json({
          connection: created,
          outcome: { ok: true, httpStatus: 200, errorCode: null },
        }),
      ),
    );
    await event.click(
      screen.getByRole('button', { name: 'New Slack connection' }),
    );
    const lens = within(await screen.findByRole('dialog'));
    expect(lens.getByText('Connect Slack')).toBeVisible();
    await event.type(
      lens.getByLabelText('Slack bot token'),
      'xoxb-1234567890-secret',
    );
    await event.click(lens.getByRole('button', { name: 'Continue' }));
    await event.click(lens.getByRole('button', { name: 'Save and test' }));
    expect(await lens.findByText('Slack accepted the token.')).toBeVisible();
    await event.click(lens.getByRole('button', { name: 'Done' }));

    expect(
      await screen.findByText('Connected Control Operations Slack'),
    ).toBeVisible();
    expect(screen.queryByText('Connect Slack')).toBeNull();
    expect(screen.getByLabelText('Slack connection')).toHaveTextContent(
      'Control Operations Slack',
    );
    pressSave();
    await waitFor(() => {
      expect(saved.graph?.nodes[0]?.connectionRefs).toEqual({
        slack_bot_token: createdId,
      });
    });
  });

  it('leaves a channel from another source to the Inputs tab', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: slackGraph({
          channelId: { kind: 'run_input', path: '$.channel' },
        }),
        definitions: [slackDefinition],
      }),
    );
    renderApp(editorPath);
    fireEvent.click((await findCanvas()).getByText('Tell ops'));
    const setup = await screen.findByRole('tabpanel', { name: 'Setup' });
    expect(
      within(setup).getByText(/comes from another source on the Inputs tab/u),
    ).toBeVisible();
    expect(within(setup).queryByLabelText('Channel ID')).toBeNull();
  });
});
